import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  ActivityDraftPatchWritable,
  ActivityInputWritable,
  ActivityInput,
  ActivityPublicationContent,
  ReasonAction,
  VersionAction,
} from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database, json } from '../database.js';
import { envelope, invisible, checkVersion, wrongState, invalid } from '../http.js';
import { managedScope, includeView, project, pagination, publishedRevision, workingRevision } from './read.js';
import { audit } from '../audit.js';
import { Workflow } from '../workflow.js';
import { reviewView, detail, snapshot } from './views.js';
import { parseGroupImage } from './group-image.js';
import { content } from './validation.js';
import { checkRecruitmentRevision } from './recruitment.js';
import { validate } from '../validation.js';

@Controller('organizer')
export class DraftController {
  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}
  @Get('activities/:id') async detail(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.db.activity.findFirst({
      where: { id, ...managedScope(req.actor) },
      include: includeView,
    });
    if (!row) invisible();
    return envelope(detail(row));
  }
  @Get('activities/:id/revisions') async revisions(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    const scope = managedScope(req.actor);
    return this.db.$transaction(
      async (tx) => {
        if (!(await tx.activity.findFirst({ where: { id, ...scope }, select: { id: true } })))
          invisible();
        const { page, page_size, skip } = pagination(q);
        const where = { activity_id: id };
        const total = await tx.activityRevision.count({ where });
        const rows =
          skip < total
            ? await tx.activityRevision.findMany({
                where,
                orderBy: { revision: 'desc' },
                skip,
                take: page_size,
              })
            : [];
        return envelope({ items: rows.map(snapshot), total, page, page_size });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Get('activities/:id/revisions/:rev') async revision(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rev', ParseIntPipe) rev: number,
  ) {
    const scope = managedScope(req.actor);
    // ParseIntPipe accepts integers beyond PostgreSQL's integer range.
    if (rev > 2147483647 || rev < -2147483648) invisible();
    const r = await this.db.activityRevision.findUnique({
      where: {
        activity_id_revision: { activity_id: id, revision: rev },
        activity: scope,
      },
    });
    if (!r) invisible();
    return envelope(snapshot(r));
  }
  @Post('activities') create(@Req() req: SessionRequest, @Body() body: unknown) {
    return this.workflow.run(req, null, 'create', async (tx) => {
      const { group_qr_upload, group_qr_id, ...input } = validate<ActivityInputWritable>(
        'activity_input',
        body,
      );
      if (group_qr_id) invalid('group_qr_id', '请上传本活动的群二维码');
      const image = parseGroupImage(group_qr_upload);
      const a = content({ ...input, ...(image && { group_qr_id: image.id }) });
      const owner = req.actor.account_id;
      const [seq] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('activity_code_seq') AS n`;
      const year = new Date().toLocaleDateString('en', {
        year: 'numeric',
        timeZone: 'Asia/Shanghai',
      });
      const row = await tx.activity.create({
        data: {
          activity_code: 'P' + year + '-' + seq.n,
          working_revision: 1,
          ...(image && { group_images: { create: image } }),
          members: { create: { account_id: owner, member_role: 'owner' } },
          revisions: {
            create: { revision: 1, content: json(a), revision_state: 'draft', created_by: owner },
          },
        },
        include: includeView,
      });
      return project(row, 'working', new Date());
    });
  }
  @Delete('activities/:id')
  remove(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workflow.run(req, { activityId: id }, 'deleteDraft', async (tx, loaded, actor) => {
      const row = loaded!;
      if (row.deleted_at) invisible();
      checkVersion(row.version, validate<VersionAction>('version_action', body).expected_version);
      if (row.status !== 'draft' || row.published_revision !== null || row.reviews.some(review => review.status === 'pending'))
        wrongState();
      const removed = await tx.activity.update({
        where: { id }, data: { deleted_at: new Date(), version: { increment: 1 } },
        select: { version: true, deleted_at: true },
      });
      await audit(tx, { actor_id: actor.account_id, action: 'delete_activity_draft', resource_type: 'activity',
        resource_id: id, before: { activity_code: row.activity_code, version: row.version }, after: { version: removed.version, deleted_at: removed.deleted_at?.toISOString() } });
      return { completed: true, resource_id: id, version: removed.version };
    });
  }
  @Patch('activities/:id') patch(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { activityId: id }, 'manage', async (tx, loaded) => {
      const row = loaded!,
        { expected_version, ...patch } = validate<ActivityDraftPatchWritable>(
          'activity_draft_patch',
          body,
        );
      checkVersion(row.version, expected_version);
      if (
        !['draft', 'published'].includes(row.status) ||
        row.reviews.some((r) => r.status === 'pending')
      )
        wrongState();
      if (!Object.keys(patch).length) return project(row, 'working', new Date());
      const old = workingRevision(row)!;
      const { group_qr_upload, ...changes } = patch;
      const image = parseGroupImage(group_qr_upload);
      if (
        changes.group_qr_id &&
        !(await tx.activityGroupImage.count({
          where: { id: changes.group_qr_id, activity_id: id },
        }))
      )
        invalid('group_qr_id', '请选择本活动的群二维码');
      if (image) {
        await tx.activityGroupImage.create({ data: { ...image, activity_id: id } });
        changes.group_qr_id = image.id;
      }
      const merged = Object.fromEntries(
        Object.entries({ ...(old.content as object), ...changes }).filter(([, v]) => v !== null),
      );
      const next = json(content(merged));
      let revision = old.revision;
      if (old.revision_state === 'draft')
        await tx.activityRevision.update({
          where: { activity_id_revision: { activity_id: id, revision } },
          data: { content: next },
        });
      else {
        revision = row.working_revision + 1;
        await tx.activityRevision.create({
          data: {
            activity_id: id,
            revision,
            revision_state: 'draft',
            created_by: req.actor.account_id,
            content: next,
          },
        });
      }
      const previousImage = (old.content as unknown as ActivityInput).group_qr_id;
      if (old.revision_state === 'draft' && previousImage && previousImage !== merged.group_qr_id) {
        const references = await tx.activityRevision.count({
          where: {
            activity_id: id,
            content: { path: ['group_qr_id'], equals: previousImage },
          },
        });
        if (!references) await tx.activityGroupImage.delete({ where: { id: previousImage } });
      }
      const updated = await tx.activity.update({
        where: { id },
        data: { version: { increment: 1 }, working_revision: revision },
        include: includeView,
      });
      return project(updated, 'working', new Date());
    });
  }
  @Post('activities/:id/submit') submit(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { activityId: id }, 'manage', async (tx, loaded) => {
      const row = loaded!;
      checkVersion(row.version, validate<VersionAction>('version_action', body).expected_version);
      const revision = row.working_revision,
        old = row.revisions.find((r) => r.revision === revision)!;
      if (
        !['draft', 'published'].includes(row.status) ||
        old.revision_state !== 'draft' ||
        row.reviews.some((r) => r.status === 'pending')
      )
        wrongState();
      const proposed = content(old.content, true);
      await checkRecruitmentRevision(tx, id, publishedRevision(row)?.content as unknown as ActivityPublicationContent | undefined, proposed);
      await tx.activityRevision.update({
        where: { activity_id_revision: { activity_id: id, revision } },
        data: { revision_state: 'pending_review' },
      });
      const review = await tx.activityReview.create({
        data: {
          revision,
          activity_id: id,
          submitted_by: req.actor.account_id,
          previous_revision: row.published_revision,
        },
      });
      const updated = await tx.activity.update({
        where: { id },
        data: {
          version: { increment: 1 },
          status: row.published_revision ? 'published' : 'pending_review',
        },
        include: includeView,
      });
      return reviewView(updated, review);
    });
  }
  @Post('activity-reviews/:id/withdraw') @HttpCode(200) withdraw(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { reviewId: id }, 'manage', async (tx, loaded) => {
      const row = loaded!,
        r = row.reviews.find((r) => r.id === id)!,
        action = validate<ReasonAction>('reason_action', body);
      checkVersion(r.version, action.expected_version);
      if (r.status !== 'pending' || !['published', 'pending_review'].includes(row.status))
        wrongState();
      const result = await tx.activityReview.update({
        where: { id },
        data: { status: 'withdrawn', version: { increment: 1 }, reason: action.reason },
      });
      await tx.activityRevision.update({
        where: { activity_id_revision: { activity_id: row.id, revision: r.revision } },
        data: { revision_state: 'withdrawn' },
      });
      const updated = await tx.activity.update({
        where: { id: row.id },
        data: { version: { increment: 1 }, status: row.published_revision ? 'published' : 'draft' },
        include: includeView,
      });
      return reviewView(updated, result);
    });
  }
}
