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
import type { ReviewDecision } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, invalid, invisible } from '../http.js';
import { includeView, paginate, staff } from './read.js';
import { checkVersion, reviewView, Workflow, wrongState } from './workflow.js';
import { content, validate } from './validation.js';

const notifiedFields = new Set([
  'schedule',
  'registration_opens_at',
  'registration_closes_at',
  'result_expected_at',
  'campus',
  'location',
  'meeting_point',
  'transport_notes',
  'capacity',
  'eligibility_text',
  'selection_text',
  'group_join_instructions',
  'hours_rule_text',
  'expected_hours',
  'expected_hours_basis',
  'hours_import_expected_at',
]);

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
    const reviews = await this.db.activityReview.findMany({
      where: { status: q.status },
      include: { activity: { include: includeView } },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
    });
    return envelope(
      paginate(
        reviews.map((r) => reviewView(r.activity, r)),
        q,
      ),
    );
  }
  @Get(':id') async get(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!staff(req.actor)) denied();
    const r = await this.db.activityReview.findUnique({
      where: { id },
      include: { activity: { include: includeView } },
    });
    if (!r) invisible();
    return envelope(reviewView(r.activity, r));
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
        }
      }
      return result;
    });
  }
}
