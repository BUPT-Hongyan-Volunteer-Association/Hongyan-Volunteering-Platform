import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { Activity as View } from '@hongyan/contracts/types';
import { Database } from '../database.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { publishedRevision } from './revisions.js';
import { activityPage } from './list.js';
import { includeView, project, type LoadedActivity } from './read.js';

function publicView(row: LoadedActivity & { registrations: { status: string }[] }, now: Date) {
  const result = project(row, 'published', now, false);
  if (!result) invisible();
  const own = row.registrations[0];
  if (own) result.my_registration_status = own.status as View['my_registration_status'];
  if (own?.status === 'accepted') {
    const approved = publishedRevision(row)!;
    result.group_join_instructions = (
      approved.content as { group_join_instructions?: string }
    ).group_join_instructions;
  }
  return result;
}
@Controller('activities')
export class PublicController {
  constructor(private db: Database) {}
  @Get() async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    if (q.review_status !== undefined || q.owner_account_id !== undefined) denied();
    if (q.scope && !['public', 'mine'].includes(q.scope)) invalid('scope', '公开查询范围无效');
    const id = req.actor.student?.id ?? '00000000-0000-0000-0000-000000000000';
    const statuses = q.status
      ? [q.status]
      : q.scope === 'mine'
        ? ['published', 'completed', 'cancelled']
        : ['published'];
    const where = {
      published_revision: { not: null },
      status: { in: statuses.filter((s) => ['published', 'completed', 'cancelled'].includes(s)) },
      ...(q.scope === 'mine' && {
        registrations: { some: { student_id: id, status: 'accepted' } },
      }),
    };
    return envelope(await activityPage(this.db, where, 'public', q, req.actor.student?.id));
  }
  @Get(':id') async detail(
    @Req() req: SessionRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const row = await this.db.activity.findFirst({
      where: {
        id,
        published_revision: { not: null },
        status: { in: ['published', 'cancelled', 'completed'] },
      },
      include: {
        ...includeView,
        registrations: {
          where: { student_id: req.actor.student?.id ?? '00000000-0000-0000-0000-000000000000' },
          select: { status: true },
        },
      },
    });
    if (!row) invisible();
    return envelope(publicView(row, new Date()));
  }
}
