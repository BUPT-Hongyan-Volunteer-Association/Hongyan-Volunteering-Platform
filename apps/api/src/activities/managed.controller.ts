import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import { activityPage } from './list.js';
import { managedScope } from './read.js';

@Controller('organizer/activities')
export class ManagedController {
  constructor(private db: Database) {}
  @Get() async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const scope = q.revision_scope ?? 'working';
    if (scope !== 'working' && scope !== 'published') invalid('revision_scope', '版本范围无效');
    const access = managedScope(req.actor, q.scope);
    if (
      q.owner_account_id &&
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.owner_account_id)
    )
      invalid('owner_account_id', '负责人编号无效');
    const where = {
      AND: [
        access,
        {
          status: q.status || undefined,
          ...(scope === 'published' && { published_revision: { not: null } }),
          ...(q.owner_account_id && {
            members: { some: { member_role: 'owner' as const, account_id: q.owner_account_id } },
          }),
        },
      ],
    };
    return envelope(await activityPage(this.db, where, scope, q));
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
