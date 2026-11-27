import { parseActivityFilters, publishedActivityFilter } from './filters.js';
import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { activityPage } from './list.js';
import type { ActivityPublicationContent } from '@hongyan/contracts/types';
import { questionnaireVersion, registrationInventory } from '../registrations/enrollment.js';
import { registrationView, includeResponse } from '../registrations/registration.js';
import { includeView, project } from './read.js';

@Controller('activities')
export class PublicController {
  constructor(private db: Database) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const scope = q.scope ?? 'public';
    if (scope !== 'public' && scope !== 'mine') invalid('scope', '公开查询范围无效');
    const range = parseActivityFilters(q, false);
    const studentId = req.actor.student?.id;
    const where = publishedActivityFilter(scope, q.status, studentId);
    return envelope(await activityPage(this.db, where, 'public', q, { studentId, range }));
  }
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async detail(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const studentId = req.actor.student?.id;
    return this.db.$transaction(async (tx) => {
      const row = await tx.activity.findFirst({
        where: { id, status: { in: ['published', 'cancelled', 'completed'] } },
        include: {
          members: includeView.members,
          registrations: studentId ? { where: { student_id: studentId }, include: includeResponse } : false,
        },
      });
      if (!row || row.published_revision === null) invisible();
      const revision = await tx.activityRevision.findUnique({
        where: { activity_id_revision: { activity_id: id, revision: row.published_revision } },
      });
      if (!revision) invisible();
      const view = project({ ...row, revisions: [revision], reviews: [] }, 'public-detail', new Date());
      if (!view) invisible();
      const config = revision.content as unknown as ActivityPublicationContent;
      const item_availability = await registrationInventory(tx, id, config);
      return envelope({
        ...view, item_availability, questionnaire_version: questionnaireVersion(config.questions ?? []),
        my_registrations: (row.registrations ?? []).map(r => registrationView(r)),
      });
    }, { isolationLevel: 'RepeatableRead' });
  }
}
