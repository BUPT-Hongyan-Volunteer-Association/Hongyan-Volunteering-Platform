import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  RegistrationDecision,
  ActivityPublicationContent,
  BulkRegistrationDecision,
  RegistrationInput,
  RosterStatusCounts,
} from '@hongyan/contracts/types';
import { pagination, workspaceScope } from '../activities/read.js';
import { Workflow } from '../activities/workflow.js';
import { validate } from '../activities/validation.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import { canRequest, canWithdraw, canDecide, decideBatch, apply, registrationView, rosterOrderBy, rosterSearchWhere, rosterWhere } from './registration.js';

const zeroCounts: RosterStatusCounts = {
  submitted: 0,
  waitlisted: 0,
  accepted: 0,
  rejected: 0,
  withdrawn: 0,
  exited: 0,
};
function statusFilter(status?: string) {
  if (status !== undefined && (typeof status !== 'string' || !Object.hasOwn(zeroCounts, status)))
    invalid('status', '报名状态无效');
  return status as keyof RosterStatusCounts | undefined;
}
@Controller()
export class RegistrationController {
  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}

  @Post('activities/:id/registrations') submit(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { activityId: id }, 'apply', (tx, activity) =>
      apply(
        tx,
        activity!,
        studentId(req.actor),
        req.actor.account_id,
        req.receivedAt,
        validate<RegistrationInput>('registration_input', body),
      ),
    );
  }

  @Get('me/registrations') mine(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const student_id = studentId(req.actor);
    if (
      q.id !== undefined &&
      (typeof q.id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.id))
    )
      invalid('id', '报名编号无效');
    const where = { id: q.id, student_id, status: statusFilter(q.status) };
    const { page, page_size, skip } = pagination(q);
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.registration.count({ where });
        const rows =
          skip < total
            ? await tx.registration.findMany({
                where,
                orderBy: [{ submitted_at: 'desc' }, { id: 'asc' }],
                skip,
                take: page_size,
                include: { activity: { select: { published_revision: true, status: true } }, exit_requests: { where: { status: 'pending' }, select: { id: true, kind: true } } },
              })
            : [];
        const versions = rows.flatMap((r) =>
          r.activity.published_revision === null
            ? []
            : [{ activity_id: r.activity_id, revision: r.activity.published_revision }],
        );
        const approvals = new Map(
          (versions.length
            ? await tx.activityRevision.findMany({
                where: { OR: versions, revision_state: 'approved' },
                select: { activity_id: true, content: true },
              })
            : []
          ).map((r) => [r.activity_id, r.content as unknown as ActivityPublicationContent]),
        );
        return envelope({
          page,
          page_size,
          total,
          items: rows.map((r) => ({
            ...registrationView(r),
            activity_title: approvals.get(r.activity_id)?.title,
            can_withdraw: canWithdraw(r.activity.status, r.status),
            can_request_exit: !r.exit_requests.length && canRequest('exit', r.activity.status, r.status, approvals.get(r.activity_id)),
            can_request_restoration: !r.exit_requests.length && canRequest('restoration', r.activity.status, r.status, approvals.get(r.activity_id)),
            ...(r.exit_requests[0] && { [r.exit_requests[0].kind === 'exit' ? 'pending_exit_request_id' : 'pending_restoration_request_id']: r.exit_requests[0].id }),
          })),
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  @Get('organizer/activities/:id/registrations') roster(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    const scope = workspaceScope(req.actor, q.scope);
    return this.db.$transaction(
      async (tx) => {
        const activity = await tx.activity.findFirst({
          where: { id, ...scope },
          select: { published_revision: true, status: true },
        });
        if (!activity) invisible();
        const { page, page_size, skip } = pagination(q);
        const status = statusFilter(q.status);
        if (q.q !== undefined && typeof q.q !== 'string') invalid('q', '请输入姓名或学号');
        const search = q.q?.trim();
        const matching = rosterSearchWhere({ activity_id: id, q: search });
        const counts = { ...zeroCounts };
        const grouped = await tx.registration.groupBy({
          by: ['status'],
          where: matching,
          _count: true,
        });
        for (const group of grouped)
          counts[group.status as keyof RosterStatusCounts] = group._count;
        const total = status
          ? counts[status]
          : Object.values(counts).reduce((sum, count) => sum + count, 0);
        const approved =
          activity.published_revision === null
            ? null
            : await tx.activityRevision.findUnique({
                where: {
                  activity_id_revision: { activity_id: id, revision: activity.published_revision },
                },
                select: { content: true },
              });
        const content = approved?.content as unknown as ActivityPublicationContent | undefined;
        const accepted_count = search
          ? await tx.registration.count({ where: { activity_id: id, status: 'accepted' } })
          : counts.accepted;
        const rows =
          skip < total
            ? await tx.registration.findMany({
                where: rosterWhere({ activity_id: id, q: search, status }),
                skip,
                take: page_size,
                orderBy: rosterOrderBy,
                include: {
                  student: {
                    select: { student_no: true, account: { select: { display_name: true } } },
                  },
                },
              })
            : [];
        return envelope({
          page,
          page_size,
          total,
          status_counts: counts,
          accepted_count,
          capacity: content?.capacity ?? 0,
          can_decide: canDecide(activity.status, content),
          items: rows.map((r) => ({
            ...registrationView(r),
            student_name: r.student.account.display_name,
            student_no: r.student.student_no,
          })),
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  @Post('organizer/registrations/:id/decision')
  @HttpCode(200)
  decide(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.workflow.run(
      req,
      { registrationId: id },
      'workspace',
      async (tx, activity) => {
        const { expected_version, ...decision } = validate<RegistrationDecision>('registration_decision', body);
        const result = await decideBatch(tx, activity!, req.actor.account_id, {
          ...decision, items: [{ registration_id: id, expected_version }],
        });
        return result.items[0];
      },
      scope,
    );
  }

  @Post('organizer/activities/:id/registration-decisions') @HttpCode(200)
  bulk(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string,
       @Body() body: unknown, @Query('scope') scope?: string) {
    return this.workflow.run(req, { activityId: id }, 'workspace', (tx, activity, actor) =>
      decideBatch(tx, activity!, actor.account_id, validate<BulkRegistrationDecision>('bulk_registration_decision', body)), scope);
  }
}
