import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { ExitRequestInput, ReviewDecision, VersionAction } from '@hongyan/contracts/types';
import { pagination, workspaceScope } from '../activities/read.js';
import { validate } from '../activities/validation.js';
import { Workflow, checkVersion, wrongState } from '../activities/workflow.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { audit } from '../audit.js';
import { Database } from '../database.js';
import type { ExitRequest, Registration } from '../generated/prisma/client.js';
import { BusinessError, envelope, invalid, invisible } from '../http.js';
import {
  approvedContent,
  canRecruit,
  canWithdraw,
  canRequest,
  enabledStudents,
  occupiedSeats,
  queueGathering,
  recordChanges,
  registrationView,
} from './registration.js';

type Kind = 'exit' | 'restoration';
type Filters = Record<string, string>;
function view(q: ExitRequest, r: Pick<Registration, 'activity_id' | 'student_id'> & {
  student?: { student_no: string; account: { display_name: string } };
}) {
  return {
    id: q.id,
    version: q.version,
    registration_id: q.registration_id,
    activity_id: r.activity_id,
    student_id: r.student_id,
    ...(r.student && { student_no: r.student.student_no, student_name: r.student.account.display_name }),
    reason: q.reason,
    status: q.status,
    created_at: q.created_at.toISOString(),
    updated_at: q.updated_at.toISOString(),
    ...(q.decision_reason && { decision_reason: q.decision_reason }),
  };
}

@Controller()
export class RecruitmentRequests {
  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}

  @Post('me/registrations/:id/withdraw')
  @HttpCode(200)
  withdrawRegistration(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { registrationId: id }, 'self', async (tx, activity, actor) => {
      const previous = await tx.registration.findFirst({ where: { id, student_id: studentId(actor) } });
      if (!previous) invisible();
      checkVersion(previous.version, validate<VersionAction>('version_action', body).expected_version);
      if (!canWithdraw(activity!.status, previous.status)) wrongState();
      const current = await tx.registration.update({
        where: { id },
        data: { version: { increment: 1 }, status: 'withdrawn', decision_reason: null },
      });
      await recordChanges(tx, [previous], [current], new Date(), actor.account_id);
      return registrationView(current);
    });
  }

  private create(req: SessionRequest, kind: Kind, body: unknown) {
    const input = validate<ExitRequestInput>(kind + '_request_input', body);
    if (!input.reason.trim()) invalid('reason', '请填写申请原因');
    return this.workflow.run(
      req,
      { registrationId: input.registration_id },
      'self',
      async (tx, activity, actor) => {
        const r = await tx.registration.findFirst({
          where: { id: input.registration_id, student_id: studentId(actor) },
        });
        if (!r) invisible();
        checkVersion(r.version, input.expected_registration_version);
        if (!canRequest(kind, activity!.status, r.status, approvedContent(activity!))) wrongState();
        if (await tx.exitRequest.findFirst({ where: { registration_id: r.id, status: 'pending' } }))
          throw new BusinessError(409, 'invalid_state', '已有申请待处理');
        const q = await tx.exitRequest.create({
          data: { kind, registration_id: r.id, reason: input.reason.trim() },
        });
        await audit(tx, {
          actor_id: actor.account_id,
          action: 'submit',
          resource_type: kind + '_request',
          resource_id: q.id,
          reason: q.reason,
          after: { registration_id: r.id, status: q.status, version: q.version },
        });
        return view(q, r);
      },
    );
  }

  private list(req: SessionRequest, kind: Kind, q: Filters, activityId?: string) {
    const scope = activityId ? workspaceScope(req.actor, q.scope) : undefined;
    for (const id of [q.activity_id, q.request_id]) {
      if (id !== undefined && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
        invalid('id', '编号格式错误');
    }
    if (q.status && !['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'].includes(q.status))
      invalid('status', '申请状态无效');
    const where = {
      kind,
      id: q.request_id,
      status: q.status,
      registration: {
        activity_id: activityId ?? q.activity_id,
        student_id: scope ? undefined : studentId(req.actor),
      },
    };
    const { page, page_size, skip } = pagination(q);
    return this.db.$transaction(
      async (tx) => {
        if (
          scope &&
          !(await tx.activity.findFirst({ where: { id: activityId, ...scope }, select: { id: true } }))
        )
          invisible();
        const total = await tx.exitRequest.count({ where });
        const ids = { activity_id: true, student_id: true } as const;
        const rosterIdentity = {
          ...ids, student: { select: { student_no: true, account: { select: { display_name: true } } } },
        } as const;
        const rows = await tx.exitRequest.findMany({
          where, skip, take: page_size,
          orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
          include: { registration: { select: scope ? rosterIdentity : ids } },
        });
        return envelope({ page, page_size, total, items: rows.map(row => view(row, row.registration)) });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private finish(
    req: SessionRequest,
    kind: Kind,
    id: string,
    body: unknown,
    withdraw: boolean,
    scope?: string,
  ) {
    return this.workflow.run(
      req,
      { requestId: id },
      withdraw ? 'self' : 'workspace',
      async (tx, activity, actor) => {
        const q = await tx.exitRequest.findFirst({ where: { id, kind }, include: { registration: true } });
        if (!q || (withdraw && q.registration.student_id !== studentId(actor))) invisible();
        const input = withdraw
          ? {
              ...validate<VersionAction>('version_action', body),
              decision: 'withdrawn' as const,
              reason: undefined,
            }
          : validate<ReviewDecision>('review_decision', body);
        checkVersion(q.version, input.expected_version);
        if (q.status !== 'pending' || activity!.status !== 'published') wrongState();
        const r = q.registration;
        if (input.decision === 'approved') {
          if (r.status !== (kind === 'exit' ? 'accepted' : 'exited')) wrongState();
          if (kind === 'restoration') {
            const approved = approvedContent(activity!);
            if (!(await enabledStudents(tx, [r.student_id])).size || !canRecruit(approved)) wrongState();
            if ((await occupiedSeats(tx, r.activity_id)) >= approved!.capacity)
              throw new BusinessError(409, 'capacity_conflict', '当前名额已满，恢复申请仍待处理');
          }
          const current = await tx.registration.update({
            where: { id: r.id },
            data: {
              status: kind === 'exit' ? 'exited' : 'accepted',
              version: { increment: 1 },
              decision_reason: input.reason ?? null,
            },
          });
          await recordChanges(tx, [r], [current], new Date(), actor.account_id);
          if (kind === 'restoration') await queueGathering(tx, r.activity_id, [current]);
          else
            await tx.noticeReceipt.updateMany({
              where: {
                student_id: r.student_id,
                notice: { activity_id: r.activity_id, notice_kind: 'gathering' },
              },
              data: { follow_up_closed: true },
            });
        }
        const updated = await tx.exitRequest.update({
          where: { id },
          data: {
            status: input.decision,
            decision_reason: input.reason ?? null,
            version: { increment: 1 },
          },
        });
        await audit(tx, {
          actor_id: actor.account_id,
          action: input.decision,
          resource_type: kind + '_request',
          resource_id: id,
          reason: input.reason,
          before: { status: q.status, version: q.version },
          after: { status: updated.status, version: updated.version },
        });
        if (!withdraw)
          await tx.notificationEvent.create({
            data: {
              activity_id: r.activity_id,
              resource_id: id,
              event_type: 'request_decided',
              event_key: 'request_decided:' + id,
              payload: {
                kind,
                student_id: r.student_id,
                status: updated.status,
                decision_reason: updated.decision_reason,
                actor_id: actor.account_id,
              },
            },
          });
        return view(updated, r);
      },
      scope,
    );
  }

  @Post('me/exit-requests')
  createExit(@Req() req: SessionRequest, @Body() body: unknown) {
    return this.create(req, 'exit', body);
  }

  @Get('me/exit-requests')
  myExit(@Req() req: SessionRequest, @Query() q: Filters) {
    return this.list(req, 'exit', q);
  }

  @Get('organizer/activities/:id/exit-requests')
  activityExit(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Query() q: Filters) {
    return this.list(req, 'exit', q, id);
  }

  @Post('me/exit-requests/:id/withdraw')
  @HttpCode(200)
  withdrawExit(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.finish(req, 'exit', id, body, true);
  }

  @Post('organizer/exit-requests/:id/decision')
  @HttpCode(200)
  decideExit(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.finish(req, 'exit', id, body, false, scope);
  }

  @Post('me/restoration-requests')
  createRestoration(@Req() req: SessionRequest, @Body() body: unknown) {
    return this.create(req, 'restoration', body);
  }

  @Get('me/restoration-requests')
  myRestoration(@Req() req: SessionRequest, @Query() q: Filters) {
    return this.list(req, 'restoration', q);
  }

  @Get('organizer/activities/:id/restoration-requests')
  activityRestoration(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Filters,
  ) {
    return this.list(req, 'restoration', q, id);
  }

  @Post('me/restoration-requests/:id/withdraw')
  @HttpCode(200)
  withdrawRestoration(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.finish(req, 'restoration', id, body, true);
  }

  @Post('organizer/restoration-requests/:id/decision')
  @HttpCode(200)
  decideRestoration(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.finish(req, 'restoration', id, body, false, scope);
  }
}
