import { audit } from '../audit.js';
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
import type { Activity, ActivityReview } from '../generated/prisma/client.js';
import { activeRegistrationStatuses } from '@hongyan/contracts/activity';
import type { ActivityPublicationContent, ReviewDecision } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database, type Tx } from '../database.js';
import { BusinessError, denied, envelope, invalid, invisible, checkVersion, wrongState } from '../http.js';
import { includeView, pagination, publishedRevision, staff } from './read.js';
import { reviewResponse, reviewView } from './views.js';
import { Workflow } from '../workflow.js';
import { content } from './validation.js';
import { checkRecruitmentRevision } from './recruitment.js';
import { registrationInventory } from '../registrations/enrollment.js';
import { validate } from '../validation.js';
import { notifiedFields } from '../notices/notice.js';

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

function isCurrentPending(
  review: ActivityReview,
  activity: Pick<Activity, 'status' | 'working_revision' | 'published_revision'>,
  revisionState: string,
) {
  return review.status === 'pending' && review.revision === activity.working_revision &&
    review.previous_revision === activity.published_revision && revisionState === 'pending_review' &&
    ['pending_review', 'published'].includes(activity.status);
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
        const review = await tx.activityReview.findUnique({
          where: { id },
          include: { activity: { select: { status: true, working_revision: true, published_revision: true } } },
        });
        if (!review) invisible();
        const [item] = await snapshotsForReviews(tx, [review]);
        const published = review.activity.published_revision === null ? null : await tx.activityRevision.findUnique({
          where: { activity_id_revision: { activity_id: review.activity_id, revision: review.activity.published_revision } },
          select: { content: true },
        });
        const config = (published?.content ?? item.snapshot.content) as unknown as ActivityPublicationContent;
        const item_availability = await registrationInventory(tx, review.activity_id, config);
        return envelope({ ...item, item_availability, is_current_pending: isCurrentPending(review, review.activity, item.snapshot.revision_state) });
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
      const frozen = row.revisions.find((v) => v.revision === r.revision);
      if (!frozen || !isCurrentPending(r, row, frozen.revision_state)) wrongState();
      const approved = action.decision === 'approved',
        clock = new Date();
      if (approved) {
        const a = content(frozen.content, true);
        await checkRecruitmentRevision(tx, row.id, publishedRevision(row)?.content as unknown as ActivityPublicationContent | undefined, a);
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
      const source = { activity_id: row.id, revision: r.revision };
      await audit(tx, {
        actor_id: req.actor.account_id, action: 'review_activity', resource_type: 'activity_review', resource_id: id,
        reason: action.reason, before: { ...source, status: r.status, published_revision: row.published_revision },
        after: { ...source, status: action.decision, published_revision: afterPublic },
      });
      const result = reviewView(updated, decided);
      if (approved) await tx.$queryRaw`SELECT pg_notify('registration_changed', ${row.id})::text`;
      if (approved && r.previous_revision !== null) {
        const changed_fields = result.changes
          .map((c) => c.field_path)
          .filter((k) => notifiedFields.has(k.split('.')[0]));
        if (changed_fields.length) {
          const recipients = await tx.registration.findMany({
            where: { activity_id: row.id, status: { in: activeRegistrationStatuses } },
            distinct: ['student_id'], select: { student_id: true },
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
          await tx.notificationEvent.create({
            data: {
              event_type: 'activity_changed',
              event_key: `activity_change:${id}`,
              activity_id: row.id,
              resource_id: id,
              source_revision: r.revision,
              payload: {},
            },
          });
        }
      }
      return result;
    });
  }
}
