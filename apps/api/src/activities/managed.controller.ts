import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { MemberAdd, MemberReplacement, OwnerTransfer, ReasonAction } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import { audit } from '../audit.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, envelope, invalid, invisible } from '../http.js';
import { activityPage } from './list.js';
import { eligibleOrganizer, managedScope, staff, teamManagerScope } from './read.js';
import { validate } from './validation.js';
import { checkVersion, Workflow, type Tx } from './workflow.js';

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

async function staffTeam(tx: Tx, team: Awaited<ReturnType<typeof readTeam>>) {
  const owner = team.items.find(member => member.member_role === 'owner')!;
  const unavailable = await tx.account.findFirst({
    where: { id: owner.account_id, NOT: eligibleOrganizer(new Date()) },
    select: { active: true, roles: { where: { role: 'organizer' }, select: { role: true } } },
  });
  if (!unavailable) return team;
  const reason = !unavailable.active ? 'account_disabled' : unavailable.roles.length ? 'role_expired' : 'role_missing';
  return { ...team, owner_unavailable_reason: reason };
}

const teamSnapshot = (team: Awaited<ReturnType<typeof readTeam>>) => ({
  version: team.version, members: team.items.map(({ account_id, member_role }) => ({ account_id, member_role })),
});

async function switchOwner(tx: Tx, id: string, owner: string) {
  await tx.activityMember.updateMany({ where: { activity_id: id, member_role: 'owner' }, data: { member_role: 'collaborator' } });
  await tx.activityMember.update({ where: { activity_id_account_id: { activity_id: id, account_id: owner } }, data: { member_role: 'owner' } });
}

async function recordTeamChange(tx: Tx, id: string, before: Awaited<ReturnType<typeof readTeam>>,
  actorId: string, action: string, reason: string) {
  await tx.activity.update({ where: { id }, data: { team_version: { increment: 1 } } });
  const after = await readTeam(tx, { id });
  await audit(tx, { actor_id: actorId, action, resource_type: 'activity', resource_id: id,
    reason, before: teamSnapshot(before), after: teamSnapshot(after) });
  return after;
}

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
    return envelope(await activityPage(this.db, where, scope, q, {
      showOwnerAvailability: staff(req.actor) && q.scope !== 'managed',
    }));
  }
  @Get(':id/members') async members(
    @Req() req: SessionRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.db.$transaction(async tx => {
      const team = await readTeam(tx, { id, ...managedScope(req.actor) });
      return envelope(staff(req.actor) ? await staffTeam(tx, team) : team);
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Get(':id/member-candidates')
  @Header('Cache-Control', 'no-store')
  async candidate(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string,
    @Query('student_no') number: string) {
    if (typeof number !== 'string' || !/^[0-9]{10}$/.test(number)) invalid('student_no', '请输入完整的十位学号');
    return this.db.$transaction(async tx => {
      if (!await tx.activity.count({ where: { id, ...teamManagerScope(req.actor) } })) invisible();
      const match = await tx.student.findFirst({
        where: { student_no: number, account: eligibleOrganizer(new Date()) },
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
      if (!await tx.account.count({ where: { id: input.account_id, ...eligibleOrganizer(new Date()) } }))
        invalid('account_id', '该账号当前没有有效的负责人资格，请重新核对');
      await tx.activityMember.create({ data: { activity_id: id, account_id: input.account_id, member_role: 'collaborator' } });
      return recordTeamChange(tx, id, before, actor.account_id, 'add_activity_member', reason);
    });
  }
  @Delete(':id/members/:account_id')
  remove(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string,
    @Param('account_id', ParseUUIDPipe) accountId: string, @Body() body: unknown) {
    return this.workflow.run(req, { activityId: id }, 'team', async (tx, _row, actor, reauthorize) => {
      const input = validate<ReasonAction>('reason_action', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写移除原因');
      await tx.$queryRaw`SELECT id FROM account WHERE id = ${actor.account_id}::uuid FOR SHARE`;
      await reauthorize();
      const before = await readTeam(tx, { id });
      checkVersion(before.version, input.expected_version);
      const member = before.items.find(person => person.account_id === accountId.toLowerCase());
      if (!member) invisible();
      if (member.member_role === 'owner') invalid('account_id', '请先交接主负责人，再移除该成员');
      await tx.activityMember.delete({ where: { activity_id_account_id: { activity_id: id, account_id: accountId } } });
      return recordTeamChange(tx, id, before, actor.account_id, 'remove_activity_member', reason);
    });
  }

  @Post(':id/transfer-owner')
  @HttpCode(200)
  transfer(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workflow.run(req, { activityId: id }, 'team', async (tx, _row, actor, reauthorize) => {
      const input = validate<OwnerTransfer>('owner_transfer', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写交接原因');
      const target = input.target_account_id;
      await tx.$queryRaw`SELECT id FROM account WHERE id IN (${actor.account_id}::uuid, ${target}::uuid) ORDER BY id FOR SHARE`;
      await reauthorize();
      const before = await readTeam(tx, { id });
      checkVersion(before.version, input.expected_version);
      if (!before.items.some(member => member.account_id === target && member.member_role === 'collaborator') ||
          !await tx.account.count({ where: { id: target, ...eligibleOrganizer(new Date()) } }))
        invalid('target_account_id', '请选择本活动中仍有负责人资格的协作者');
      await switchOwner(tx, id, target);
      return recordTeamChange(tx, id, before, actor.account_id, 'transfer_activity_owner', reason);
    });
  }
}

@Controller('admin/activities')
export class AdminTeamController {
  constructor(private workflow: Workflow) {}

  @Put(':id/members')
  replace(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workflow.run(req, { activityId: id }, 'review', async (tx, _row, actor, reauthorize) => {
      const input = validate<MemberReplacement>('member_replacement', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写成员调整原因');
      const desired = new Map(input.members.map(member => [member.account_id.toLowerCase(), member.member_role]));
      const owners = [...desired.keys()].filter(account => desired.get(account) === 'owner');
      if (owners.length !== 1 || desired.size !== input.members.length)
        invalid('members', '成员不能重复，且必须保留一名主负责人');

      const before = await readTeam(tx, { id });
      checkVersion(before.version, input.expected_version);
      const current = new Map(before.items.map(member => [member.account_id, member.member_role]));
      const owner = owners[0];
      const previous = before.items.find(member => member.member_role === 'owner')!.account_id;
      if (owner !== previous && (current.get(owner) !== 'collaborator' || desired.get(previous) !== 'collaborator'))
        invalid('members', '请先添加接任人为协作者，交接时原主负责人须保留为协作者');

      const added = [...desired.keys()].filter(account => !current.has(account));
      const removed = [...current.keys()].filter(account => !desired.has(account));
      const qualify = owner === previous ? added : [...added, owner];
      const locks = [...qualify, actor.account_id, previous];
      await tx.$queryRaw`SELECT id FROM account WHERE id = ANY(${locks}::uuid[]) ORDER BY id FOR SHARE`;
      await reauthorize();
      if (input.require_unavailable_owner && !('owner_unavailable_reason' in await staffTeam(tx, before)))
        throw new BusinessError(409, 'invalid_state', '现任主负责人资格已恢复，请重新核对');
      if (qualify.length && await tx.account.count({ where: { id: { in: qualify }, ...eligibleOrganizer(new Date()) } }) !== qualify.length)
        invalid('members', '新增成员和接任人均须具有有效负责人资格');
      if (!added.length && !removed.length && owner === previous) return staffTeam(tx, before);
      if (removed.length) await tx.activityMember.deleteMany({ where: { activity_id: id, account_id: { in: removed } } });
      if (added.length) await tx.activityMember.createMany({ data: added.map(account_id => ({
        activity_id: id, account_id, member_role: 'collaborator',
      })) });
      if (owner !== previous) await switchOwner(tx, id, owner);
      return staffTeam(tx, await recordTeamChange(tx, id, before, actor.account_id, 'set_activity_members', reason));
    });
  }
}
