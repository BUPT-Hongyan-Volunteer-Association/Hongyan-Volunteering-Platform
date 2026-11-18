import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import { filterViews, includeView, managedScope, paginate, project } from './read.js';

@Controller('organizer/activities')
export class ManagedController {
  constructor(private db: Database) {}
  @Get() async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const scope = q.revision_scope ?? 'working';
    if (scope !== 'working' && scope !== 'published') invalid('revision_scope', '版本范围无效');
    const rows = await this.db.activity.findMany({
      where: managedScope(req.actor, q.scope),
      include: includeView,
      orderBy: [{ activity_code: 'asc' }, { id: 'asc' }],
    });
    const now = new Date();
    const items = rows
      .filter(
        (row) =>
          !q.review_status ||
          row.revisions.find((r) => r.revision === row.working_revision)?.revision_state ===
            q.review_status,
      )
      .map((row) => project(row, scope, now, true))
      .filter((x) => x !== null);
    return envelope(paginate(filterViews(items, q), q));
  }
  @Get(':id/members') async members(
    @Req() req: SessionRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const row = await this.db.activity.findFirst({
      where: { id, ...managedScope(req.actor) },
      select: {
        team_version: true,
        members: {
          select: {
            account_id: true,
            member_role: true,
            account: { select: { display_name: true, student: { select: { student_no: true } } } },
          },
        },
      },
    });
    if (!row) invisible();
    return envelope({
      version: row.team_version,
      items: row.members.map((m) => ({
        account_id: m.account_id,
        member_role: m.member_role,
        display_name: m.account.display_name,
        ...(m.account.student && { student_no: m.account.student.student_no }),
      })),
    });
  }
}
