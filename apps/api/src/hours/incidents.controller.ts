import { approvedOrigin } from './read-ledger.js';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Incident as View, IncidentDecision, IncidentInput, ReasonAction } from '@hongyan/contracts/types';
import { managedScope, pagination, staff } from '../activities/read.js';
import { parseCalendarDate } from '../activities/schedule.js';
import { validate } from '../validation.js';
import { checkVersion, wrongState, denied, envelope, invalid, invisible } from '../http.js';
import { Workflow } from '../workflow.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { audit } from '../audit.js';
import { Database } from '../database.js';
import type { Incident, Prisma } from '../generated/prisma/client.js';
import { enqueueHourNotices } from './events.js';
import { dateText, lockLedger } from './ledger-data.js';
import { beijingDay, normalizeFact } from './values.js';

export function incidentView(row: Incident, own = false): View {
  const { id, activity_id, student_id, status, version, facts, service_date, occurred_at, submitted_by,
    source_type, source_batch_id, source_row_number, reviewed_by, review_reason, revoked_at, created_at, updated_at } = row;
  return {
    id, version, activity_id, student_id, submitted_by, status: status as View['status'],
    facts: own && source_type === 'hour_import' ? '该日现场异常已核实，可在本人记录与反馈中提交说明' : facts,
    service_date: dateText(service_date), source_type: source_type as View['source_type'],
    discipline_status: 'not_enabled', created_at: created_at.toISOString(), updated_at: updated_at.toISOString(),
    ...(occurred_at && { occurred_at: occurred_at.toISOString() }),
    ...(source_batch_id && { source_batch_id, source_row_number: source_row_number! }),
    ...(reviewed_by && { reviewed_by }), ...(!own && review_reason && { review_reason }),
    ...(revoked_at && { revoked_at: revoked_at.toISOString() }),
  };
}

const statuses = ['pending', 'confirmed', 'rejected', 'revoked'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

@Controller()
export class HourIncidentsController {
  constructor(private db: Database, private workflow: Workflow) {}

  @Post('organizer/activities/:id/incidents')
  report(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const input = validate<IncidentInput>('incident_input', req.body);
    const facts = normalizeFact(input.facts);
    if (!facts) invalid('facts', '请填写现场事实');
    if (input.evidence_file_ids?.length) invalid('evidence_file_ids', '此入口暂不支持上传证据');
    const occurred_at = new Date(input.occurred_at);
    if (occurred_at > req.receivedAt) invalid('occurred_at', '发生时间不能在未来');
    const service_date = parseCalendarDate(beijingDay(occurred_at))!;
    return this.workflow.run(req, { activityId: id }, 'manage', async (tx, _, actor) => {
      const person = await tx.student.findFirst({
        where: { id: input.student_id, OR: [
          { registrations: { some: { activity_id: id } } },
          { hour_records: { some: { activity_id: id, ...approvedOrigin } } },
        ] }, select: { id: true },
      });
      const attendance = person || await tx.attendanceRecord.findFirst({
        where: { student_id: input.student_id, activity_id: id, cleared_at: null }, select: { id: true },
      });
      if (!attendance) invisible();
      const saved = await tx.incident.create({ data: { activity_id: id, student_id: input.student_id,
        service_date, occurred_at, facts, status: 'pending', source_type: 'manual', submitted_by: actor.account_id },
      });
      await audit(tx, { actor_id: actor.account_id, action: 'submit', resource_type: 'incident',
        resource_id: saved.id, after: { status: saved.status, service_date: dateText(service_date) } });
      return incidentView(saved);
    });
  }

  @Get('organizer/activities/:id/incidents')
  activity(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: Record<string, string>) {
    return this.page(query, { activity_id: id, ...(!staff(req.actor) && { OR: [
      { status: { not: 'pending' } }, { submitted_by: req.actor.account_id },
    ] }) }, false, { id, ...managedScope(req.actor) });
  }

  @Get('admin/incidents')
  queue(@Req() req: SessionRequest, @Query() query: Record<string, string>) {
    if (!staff(req.actor)) denied();
    const { status, student_id, activity_id, service_date } = query;
    if (status !== undefined && !statuses.includes(status)) invalid('status', '异常状态无效');
    for (const [field, id] of Object.entries({ student_id, activity_id })) {
      if (id !== undefined && !uuid.test(id)) invalid(field, '标识无效');
    }
    const day = service_date === undefined ? undefined : parseCalendarDate(service_date) ?? invalid('service_date', '服务日期无效');
    return this.page(query, { status, student_id, activity_id, service_date: day });
  }

  @Get('me/incidents')
  mine(@Req() req: SessionRequest, @Query() query: Record<string, string>) {
    return this.page(query, { student_id: studentId(req.actor), status: { in: ['confirmed', 'revoked'] } }, true);
  }

  private page(query: Record<string, string>, where: Prisma.IncidentWhereInput, own = false, scope?: Prisma.ActivityWhereInput) {
    const page = pagination(query);
    return this.db.$transaction(async (tx) => {
      if (scope && !await tx.activity.findFirst({ where: scope, select: { id: true } })) invisible();
      const items = await tx.incident.findMany({ where, skip: page.skip, take: page.page_size,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }] });
      return envelope({ items: items.map((row) => incidentView(row, own)), page: page.page,
        page_size: page.page_size, total: await tx.incident.count({ where }) });
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Post('admin/incidents/:id/decision') @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const input = validate<IncidentDecision>('incident_decision', req.body);
    return this.change(req, id, input, input.decision);
  }

  @Post('admin/incidents/:id/revoke') @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    return this.change(req, id, validate<ReasonAction>('reason_action', req.body), 'revoked');
  }

  private async change(req: SessionRequest, id: string, input: ReasonAction, status: 'confirmed' | 'rejected' | 'revoked') {
    if (!staff(req.actor)) denied();
    const reason = input.reason.trim();
    if (!reason) invalid('reason', '请填写核实或撤销原因');
    const reference = await this.db.incident.findUnique({ where: { id }, select: { activity_id: true } }) ?? invisible();
    return this.workflow.run(req, { activityId: reference.activity_id }, 'review', async (tx, _, actor, reauthorize) => {
      const row = await tx.incident.findUniqueOrThrow({ where: { id } });
      const service_date = dateText(row.service_date);
      await lockLedger(tx, [{ ...row, service_date }]);
      await reauthorize();
      checkVersion(row.version, input.expected_version);
      if (row.status !== (status === 'revoked' ? 'confirmed' : 'pending')) wrongState();
      if (status !== 'revoked' && row.submitted_by === actor.account_id) denied();
      const updated = await tx.incident.update({ where: { id }, data: {
        status, version: { increment: 1 }, ...(status === 'revoked' ? { revoked_at: req.receivedAt } :
          { reviewed_by: actor.account_id, review_reason: reason }),
      } });
      await audit(tx, { actor_id: actor.account_id, action: status, resource_type: 'incident', resource_id: id, reason,
        before: { status: row.status, version: row.version }, after: { status, version: updated.version } });
      if (status !== 'rejected') await enqueueHourNotices(tx, 'hours_result', id, actor.account_id, [{
        student_id: row.student_id, activity_id: row.activity_id, title: '现场异常核实结果',
        body: service_date + (status === 'revoked' ? ' 的现场异常记录已撤销' : ' 的现场异常已核实，详情见本人记录'),
      }], updated.version);
      return incidentView(updated);
    });
  }
}
