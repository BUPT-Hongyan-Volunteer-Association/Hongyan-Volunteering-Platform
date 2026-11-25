import { parseActivityFilters, publishedActivityFilter } from './filters.js';
import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { activityPage } from './list.js';
import { includeView, project } from './read.js';

@Controller('activities')
export class PublicController {
  constructor(private db: Database) {}
  @Get() async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const scope = q.scope ?? 'public';
    if (scope !== 'public' && scope !== 'mine') invalid('scope', '公开查询范围无效');
    const range = parseActivityFilters(q, false);
    const studentId = req.actor.student?.id;
    const where = publishedActivityFilter(scope, q.status, studentId);
    return envelope(await activityPage(this.db, where, 'public', q, { studentId, range }));
  }
  @Get(':id') async detail(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const studentId = req.actor.student?.id;
    return this.db.$transaction(async (tx) => {
      const row = await tx.activity.findFirst({
        where: { id, status: { in: ['published', 'cancelled', 'completed'] } },
        include: {
          members: includeView.members,
          registrations: studentId ? { where: { student_id: studentId }, select: { status: true } } : false,
        },
      });
      if (!row || row.published_revision === null) invisible();
      const revision = await tx.activityRevision.findUnique({
        where: { activity_id_revision: { activity_id: id, revision: row.published_revision } },
      });
      if (!revision) invisible();
      const view = project({ ...row, revisions: [revision], reviews: [] }, 'public-detail', new Date());
      return envelope(view ?? invisible());
    }, { isolationLevel: 'RepeatableRead' });
  }
}
