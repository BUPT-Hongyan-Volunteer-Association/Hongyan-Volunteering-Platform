import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { MemberAdd } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import { audit } from '../audit.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope, invalid, invisible } from '../http.js';
import { activityPage } from './list.js';
import { managedScope, teamManagerScope } from './read.js';
import { validate } from './validation.js';
import { checkVersion, Workflow, type Tx } from './workflow.js';

const eligible = (now: Date): Prisma.AccountWhereInput => ({
  active: true, roles: { some: { role: 'organizer', OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
});

async function readTeam(db: Tx, where: Prisma.ActivityWhereInput) {
  const row = await db.activity.findFirst({
    where, select: {
      team_version: true, members: { orderBy: [{ member_role: 'asc' }, { account_id: 'asc' }], select: {
        account_id: true, member_role: true,
        account: { select: { display_name: true, student: { select: { student_no: true } } } },
      } },
    },
  });
  if (!row) invisible();
  return { version: row.team_version, items: row.members.map(member => ({
    account_id: member.account_id, member_role: member.member_role, display_name: member.account.display_name,
    ...(member.account.student && { student_no: member.account.student.student_no }),
  })) };
}

const teamSnapshot = (team: Awaited<ReturnType<typeof readTeam>>) => ({
  version: team.version, members: team.items.map(({ account_id, member_role }) => ({ account_id, member_role })),
});

@Controller('organizer/activities')
export class ManagedController {
  constructor(private db: Database, private workflow: Workflow) {}
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
    return envelope(await this.db.$transaction(tx => readTeam(tx, { id, ...managedScope(req.actor) }),
      { isolationLevel: 'RepeatableRead' }));
  }

  @Get(':id/member-candidates')
  @Header('Cache-Control', 'no-store')
  async candidate(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string,
    @Query('student_no') number: string) {
    if (typeof number !== 'string' || !/^[0-9]{10}$/.test(number)) invalid('student_no', '请输入完整的十位学号');
    return this.db.$transaction(async tx => {
      if (!await tx.activity.count({ where: { id, ...teamManagerScope(req.actor) } })) invisible();
      const match = await tx.student.findFirst({
        where: { student_no: number, account: eligible(new Date()) },
        select: { account_id: true, student_no: true, account: { select: { display_name: true } } },
      });
      return envelope({ items: match ? [{ account_id: match.account_id, student_no: match.student_no,
        display_name: match.account.display_name }] : [] });
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Post(':id/members')
  @HttpCode(200)
  add(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workflow.run(req, { activityId: id }, 'team', async (tx, _row, actor, reauthorize) => {
      const input = validate<MemberAdd>('member_add', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写添加原因');
      await tx.$queryRaw`SELECT id FROM account WHERE id IN (${actor.account_id}::uuid, ${input.account_id}::uuid) ORDER BY id FOR SHARE`;
      await reauthorize();
      const before = await readTeam(tx, { id });
      checkVersion(before.version, input.expected_version);
      if (before.items.some(member => member.account_id === input.account_id)) return before;
      if (!await tx.account.count({ where: { id: input.account_id, ...eligible(new Date()) } }))
        invalid('account_id', '该账号当前没有有效的负责人资格，请重新核对');
      await tx.activityMember.create({ data: { activity_id: id, account_id: input.account_id, member_role: 'collaborator' } });
      await tx.activity.update({ where: { id }, data: { team_version: { increment: 1 } } });
      const after = await readTeam(tx, { id });
      await audit(tx, { actor_id: actor.account_id, action: 'add_activity_member', resource_type: 'activity',
        resource_id: id, reason, before: teamSnapshot(before), after: teamSnapshot(after) });
      return after;
    });
  }
}
