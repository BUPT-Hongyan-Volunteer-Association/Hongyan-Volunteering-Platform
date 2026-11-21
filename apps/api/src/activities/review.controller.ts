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
import type { ActivityReview } from '../generated/prisma/client.js';
import type { ReviewDecision } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, invalid, invisible } from '../http.js';
import { includeView, pagination, staff } from './read.js';
import {
  checkVersion,
  reviewResponse,
  reviewView,
  type Tx,
  Workflow,
  wrongState,
} from './workflow.js';
import { content, validate } from './validation.js';
import { notifiedFields as notifiedFieldList } from '../notices/notice.js';

// 会通知到学生的字段直接引用通知模块的清单，新增字段只改一处，
// 也保证"登记了什么变更"和"通知里写了什么"永远对得上。
const notifiedFields = new Set<string>(notifiedFieldList);

// Each review references a frozen revision and, for amendments, its previous public revision.
async function snapshotsForReviews(tx: Tx, reviews: ActivityReview[]) {
  const refs = reviews.flatMap((r) =>
    [r.revision, r.previous_revision]
      .filter((revision) => revision !== null)
      .map((revision) => ({ activity_id: r.activity_id, revision })),
  );
  if (!refs.length) return [];
  const snapshots = await tx.activityRevision.findMany({ where: { OR: refs } });
  const byVersion = new Map(snapshots.map((s) => [s.activity_id + '/' + s.revision, s]));
  return reviews.map((r) =>
    reviewResponse(
      r,
      byVersion.get(r.activity_id + '/' + r.revision)!,
      byVersion.get(r.activity_id + '/' + r.previous_revision),
    ),
  );
}

@Controller('admin/activity-reviews')
export class ReviewController {
  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}
  @Get() async queue(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    if (!staff(req.actor)) denied();
    if (q.status && !['pending', 'approved', 'rejected'].includes(q.status))
      invalid('status', '审核状态无效');
    const { page, page_size, skip } = pagination(q);
    const where = { status: q.status };
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.activityReview.count({ where });
        const rows =
          skip < total
            ? await tx.activityReview.findMany({
                where,
                orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
                skip,
                take: page_size,
              })
            : [];
        return envelope({ items: await snapshotsForReviews(tx, rows), total, page, page_size });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Get(':id') async get(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!staff(req.actor)) denied();
    return this.db.$transaction(
      async (tx) => {
        const review = await tx.activityReview.findUnique({ where: { id } });
        if (!review) invisible();
        const [item] = await snapshotsForReviews(tx, [review]);
        return envelope(item);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Post(':id/decision') @HttpCode(200) decide(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { reviewId: id }, 'review', async (tx, loaded) => {
      const row = loaded!,
        r = row.reviews.find((r) => r.id === id)!,
        action = validate<ReviewDecision>('review_decision', body);
      if (req.actor.account_id === r.submitted_by)
        throw new BusinessError(403, 'forbidden', '提交人与审核人必须为不同账号');
      checkVersion(r.version, action.expected_version);
      if (
        r.status !== 'pending' ||
        r.revision !== row.working_revision ||
        !['pending_review', 'published'].includes(row.status)
      )
        wrongState();
      const frozen = row.revisions.find((v) => v.revision === r.revision)!;
      if (
        frozen.revision_state !== 'pending_review' ||
        r.previous_revision !== row.published_revision
      )
        wrongState();
      const approved = action.decision === 'approved',
        clock = new Date();
      if (approved) {
        const a = content(frozen.content, true),
          accepted = await tx.registration.count({
            where: { activity_id: row.id, status: 'accepted' },
          });
        if (a.capacity < accepted)
          throw new BusinessError(409, 'capacity_conflict', '名额不能少于已录取人数');
      }
      const afterPublic = approved ? r.revision : row.published_revision;
      const decided = await tx.activityReview.update({
        where: { id },
        data: {
          status: action.decision,
          reviewed_by: req.actor.account_id,
          reviewed_at: clock,
          reason: action.reason,
          version: { increment: 1 },
        },
      });
      await tx.activityRevision.update({
        where: { activity_id_revision: { activity_id: row.id, revision: r.revision } },
        data: { revision_state: action.decision, ...(approved && { approved_at: clock }) },
      });
      const updated = await tx.activity.update({
        where: { id: row.id },
        data: {
          status: afterPublic ? 'published' : 'draft',
          published_revision: afterPublic,
          version: { increment: 1 },
        },
        include: includeView,
      });
      await tx.reviewAudit.create({
        data: {
          review_id: id,
          activity_id: row.id,
          actor_id: req.actor.account_id,
          revision: r.revision,
          before_status: r.status,
          after_status: action.decision,
          before_public: row.published_revision,
          after_public: afterPublic,
          reason: action.reason,
        },
      });
      const result = reviewView(updated, decided);
      if (approved && r.previous_revision !== null) {
        const changed_fields = result.changes
          .map((c) => c.field_path)
          .filter((k) => notifiedFields.has(k.split('.')[0]));
        if (changed_fields.length) {
          const recipients = await tx.registration.findMany({
            where: { activity_id: row.id, status: { in: ['submitted', 'waitlisted', 'accepted'] } },
            select: { student_id: true },
          });
          await tx.activityChangeEvent.createMany({
            data: recipients.map((p) => ({
              ...p,
              activity_id: row.id,
              review_id: id,
              revision: r.revision,
              changed_fields,
            })),
          });
          // 与业务写入同事务登记待发送事件：键按审核唯一，重复审批不会重复投递。
          await tx.notificationEvent.createMany({
            data: [
              {
                event_type: 'activity_changed',
                event_key: `activity_change:${id}`,
                activity_id: row.id,
                resource_id: id,
                source_revision: r.revision,
                payload: {
                  review_id: id,
                  revision: r.revision,
                  previous_revision: r.previous_revision,
                  changed_fields,
                  recipients: recipients.map((p) => p.student_id),
                  actor_id: req.actor.account_id,
                },
              },
            ],
            skipDuplicates: true,
          });
        }
      }
      return result;
    });
  }
}
