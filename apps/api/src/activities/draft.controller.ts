import {
  Body,
  Controller,
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
  ActivityDraftPatch,
  ActivityInput,
  ReasonAction,
  VersionAction,
} from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope, invisible } from '../http.js';
import { managedScope, includeView, project, pagination, workingRevision } from './read.js';
import {
  Workflow,
  checkVersion,
  wrongState,
  reviewView,
  detail,
  snapshot,
  json,
} from './workflow.js';
import { content, validate } from './validation.js';

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
      const a = content(body),
        owner = req.actor.account_id;
      const [seq] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('activity_code_seq') AS n`;
      const year = new Date().toLocaleDateString('en', {
        year: 'numeric',
        timeZone: 'Asia/Shanghai',
      });
      const row = await tx.activity.create({
        data: {
          activity_code: 'P' + year + '-' + seq.n,
          working_revision: 1,
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
  @Patch('activities/:id') patch(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.workflow.run(req, { activityId: id }, 'manage', async (tx, loaded) => {
      const row = loaded!,
        { expected_version, ...patch } = validate<ActivityDraftPatch>('activity_draft_patch', body);
      checkVersion(row.version, expected_version);
      if (
        !['draft', 'published'].includes(row.status) ||
        row.reviews.some((r) => r.status === 'pending')
      )
        wrongState();
      const old = workingRevision(row)!;
      const merged = { ...(old.content as unknown as ActivityInput), ...patch };
      if (patch.expected_hours === null && patch.expected_hours_basis === null) {
        delete merged.expected_hours;
        delete merged.expected_hours_basis;
      }
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
      content(old.content, true);
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
