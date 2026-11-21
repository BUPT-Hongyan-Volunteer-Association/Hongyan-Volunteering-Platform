import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { HourCorrectionGroupInput, HourReviewDecision, ReasonAction } from '@hongyan/contracts/types';
import { managedScope, pagination, staff } from '../activities/read.js';
import { validate } from '../activities/validation.js';
import { Workflow } from '../activities/workflow.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import type { Prisma } from '../generated/prisma/client.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import { correctionActivities, createGroup, groupActivities, groupView, reviewGroup, withdrawGroup } from './correction-groups.js';

const statuses = ['pending_review', 'approved', 'rejected', 'withdrawn'];
type QueryValues = Record<string, string>;

@Controller()
export class HourCorrectionsController {
  constructor(private db: Database, private workflow: Workflow) {}

  @Post('organizer/hour-correction-groups')
  create(@Req() req: SessionRequest) {
    managedScope(req.actor);
    const input = validate<HourCorrectionGroupInput>('hour_correction_group_input', req.body);
    return this.workflow.run(req, { activityIds: (tx) => correctionActivities(tx, input) }, 'manage',
      (tx, _, actor, reauthorize) => createGroup(tx, input, actor, req.receivedAt, reauthorize));
  }

  @Get('organizer/activities/:id/hour-correction-groups')
  activity(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    const scope = managedScope(req.actor);
    return this.page(query, {
      activities: { some: { activity_id: id }, every: { activity: scope } },
    }, { id, ...scope });
  }

  @Get('admin/hour-correction-groups')
  queue(@Req() req: SessionRequest, @Query() query: QueryValues) {
    if (!staff(req.actor)) denied();
    return this.page(query, {});
  }

  private page(query: QueryValues, where: Prisma.HourCorrectionGroupWhereInput, activity?: Prisma.ActivityWhereInput) {
    const page = pagination(query);
    const status = query.status;
    if (status !== undefined && !statuses.includes(status)) invalid('status', '修复组状态无效');
    return this.db.$transaction(async (tx) => {
      if (activity && !await tx.activity.findFirst({ where: activity, select: { id: true } })) invisible();
      const filter = { ...where, status };
      const items = await tx.hourCorrectionGroup.findMany({
        where: filter, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], skip: page.skip, take: page.page_size,
      });
      return envelope({ items: items.map(groupView), total: await tx.hourCorrectionGroup.count({ where: filter }),
        page: page.page, page_size: page.page_size });
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Get('hour-correction-groups/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const group = await this.db.hourCorrectionGroup.findFirst({
      where: { id, activities: { every: { activity: managedScope(req.actor) } } },
    });
    return envelope(groupView(group ?? invisible()));
  }

  @Post('hour-correction-groups/:id/withdraw') @HttpCode(200)
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    managedScope(req.actor);
    const input = validate<ReasonAction>('reason_action', req.body);
    return this.workflow.run(req, { activityIds: (tx) => groupActivities(tx, id) }, 'manage',
      (tx, _, actor) => withdrawGroup(tx, id, input, actor));
  }

  @Post('admin/hour-correction-groups/:id/decision') @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    if (!staff(req.actor)) denied();
    const input = validate<HourReviewDecision>('hour_review_decision', req.body);
    return this.workflow.run(req, { activityIds: (tx) => groupActivities(tx, id) }, 'review',
      (tx, _, actor, reauthorize) => reviewGroup(tx, id, input, actor, req.receivedAt, reauthorize));
  }
}
