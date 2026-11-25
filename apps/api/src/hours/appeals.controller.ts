import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { AppealDecision, AppealInput } from '@hongyan/contracts/types';
import { managedScope, pagination, staff } from '../activities/read.js';
import { validate } from '../validation.js';
import { Workflow } from '../workflow.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import type { Prisma } from '../generated/prisma/client.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import { appealActivity, appealInclude, appealViews, createAppeal, decideAppeal } from './appeals.js';

type QueryValues = Record<string, string>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

@Controller()
export class HourAppealsController {
  constructor(private db: Database, private workflow: Workflow) {}

  @Post('me/appeals')
  create(@Req() req: SessionRequest) {
    studentId(req.actor);
    const input = validate<AppealInput>('appeal_input', req.body);
    if (input.target_type === 'restriction') invalid('target_type', '当前未启用限制规则');
    return this.workflow.run(req, { activityIds: (tx) => appealActivity(tx, input, req.actor) }, 'self',
      (tx, _, actor) => createAppeal(tx, input, actor, req.receivedAt));
  }

  @Get('me/appeals')
  mine(@Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.page(query, { student_id: studentId(req.actor) }, true);
  }

  @Get('organizer/activities/:id/appeals')
  activity(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.page(query, { activity_id: id, target_type: { in: ['hours', 'missing_hours'] } },
      false, { id, ...managedScope(req.actor) });
  }

  @Get('admin/appeals')
  queue(@Req() req: SessionRequest, @Query() query: QueryValues) {
    if (!staff(req.actor)) denied();
    return this.page(query, {}, false);
  }

  private page(query: QueryValues, scope: Prisma.HourAppealWhereInput, own: boolean, activity?: Prisma.ActivityWhereInput) {
    const page = pagination(query);
    const { status, appeal_id: id } = query;
    if (status !== undefined && !['pending', 'in_review', 'resolved', 'rejected'].includes(status)) invalid('status', '反馈状态无效');
    if (id !== undefined && !uuid.test(id)) invalid('appeal_id', '反馈编号无效');
    return this.db.$transaction(async (tx) => {
      if (activity && !await tx.activity.findFirst({ where: activity, select: { id: true } })) invisible();
      const where = { ...scope, status, id };
      const rows = await tx.hourAppeal.findMany({
        where, include: appealInclude, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], skip: page.skip, take: page.page_size,
      });
      return envelope({ items: await appealViews(tx, rows, own), page: page.page, page_size: page.page_size,
        total: await tx.hourAppeal.count({ where }) });
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Post('admin/appeals/:id/decision') @HttpCode(200)
  async decide(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    if (!staff(req.actor)) denied();
    const input = validate<AppealDecision>('appeal_decision', req.body);
    const appeal = await this.db.hourAppeal.findUnique({ where: { id }, select: { activity_id: true } }) ?? invisible();
    return this.workflow.run(req, { activityId: appeal.activity_id }, 'review', (tx, _, actor) =>
      decideAppeal(tx, id, { ...input,
        correction_group_id: input.correction_group_id?.toLowerCase(),
        correction_batch_id: input.correction_batch_id?.toLowerCase(),
      }, actor));
  }
}
