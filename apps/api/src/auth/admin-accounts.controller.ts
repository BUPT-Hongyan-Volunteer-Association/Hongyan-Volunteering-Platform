import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AccountStatusPatch, RoleReplacement, StaffAccountInput } from '@hongyan/contracts/types';
import { checkVersion, Workflow, type Tx } from '../activities/workflow.js';
import { validate } from '../activities/validation.js';
import { audit } from '../audit.js';
import { Prisma, Role } from '../generated/prisma/client.js';
import { pagination } from '../activities/read.js';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, invalid, invisible } from '../http.js';
import { StaffGuard } from '../students/staff.guard.js';
import type { Actor, SessionRequest } from './session.guard.js';

const fields = {
  id: true, username: true, password_hash: true, display_name: true, active: true, version: true, roles_version: true,
  student: { select: { id: true } },
  roles: { select: { role: true, expires_at: true }, orderBy: { role: 'asc' } },
} satisfies Prisma.AccountSelect;
type Row = Prisma.AccountGetPayload<{ select: typeof fields }>;

function scope(actor: Actor): Prisma.AccountWhereInput {
  return actor.roles.includes('tech_admin') ? {} : {
    student: { isNot: null },
    roles: { none: { role: { in: ['reviewer', 'tech_admin'] } } },
  };
}

function grants(row: Row) {
  return row.roles.map(({ role, expires_at }) => ({
    role, ...(expires_at && { expires_at: expires_at.toISOString() }),
  }));
}

function summary(row: Row) {
  return {
    account_id: row.id, version: row.version, username: row.username, display_name: row.display_name,
    status: row.active ? 'active' : 'inactive', ...(row.student && { student_id: row.student.id }),
    ...(row.password_hash === null && { credential_pending: true }), roles: grants(row),
  };
}

// Take the same transaction lock before checking the post-change administrator set.
async function requirePermanentAdmin(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('account:permanent-tech-admin', 0))`;
  const [result] = await tx.$queryRaw<{ available: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM account a JOIN role_grant g ON g.account_id = a.id
      WHERE a.active AND a.password_hash ~ '^[^:]+:[0-9a-fA-F]{128}$'
        AND g.role = 'tech_admin' AND g.expires_at IS NULL
    ) AS available`;
  if (!result.available) throw new BusinessError(409, 'invalid_state', '须保留至少一个可登录且角色长期有效的技术管理员');
}

@Controller('admin/accounts')
@UseGuards(StaffGuard)
export class AdminAccountsController {
  constructor(private db: Database, private workflow: Workflow) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: SessionRequest, @Query() query: Record<string, string>) {
    const { page, page_size, skip } = pagination(query);
    const { q, status, role, username } = query;
    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) invalid('q', '查询条件最多 100 字');
    if (status !== undefined && !['active', 'inactive'].includes(status)) invalid('status', '账号状态无效');
    if (role !== undefined && (typeof role !== 'string' || !Object.hasOwn(Role, role))) invalid('role', '角色无效');
    if (username !== undefined && (typeof username !== 'string' || !username || username.length > 64))
      invalid('username', '请输入完整登录账号，最多 64 字');
    const where: Prisma.AccountWhereInput = { AND: [
      scope(req.actor),
      username ? { username } : {},
      q && /^\d{10}$/.test(q) ? { student: { student_no: q } } : q ? {
        OR: [{ username: { contains: q } }, { display_name: { contains: q } }],
      } : {},
      status ? { active: status === 'active' } : {},
      role ? { roles: { some: { role: role as Role, OR: [{ expires_at: null }, { expires_at: { gt: req.receivedAt } }] } } } : {},
    ] };
    const [total, rows] = await this.db.$transaction([
      this.db.account.count({ where }),
      this.db.account.findMany({ where, select: fields, orderBy: { username: 'asc' }, skip, take: page_size }),
    ], { isolationLevel: 'RepeatableRead' });
    return envelope({ items: rows.map(summary), total, page, page_size });
  }

  private async read(actor: Actor, id: string) {
    const [row] = await this.db.$transaction([
      this.db.account.findFirst({ where: { id, ...scope(actor) }, select: fields }),
    ], { isolationLevel: 'RepeatableRead' });
    if (!row) return actor.roles.includes('tech_admin') ? invisible() : denied();
    return row;
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async detail(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(summary(await this.read(req.actor, id)));
  }

  @Patch(':id')
  setStatus(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const checkAccess = async (tx: Tx) => {
      const target = await tx.account.findUnique({ where: { id }, select: { student: { select: { id: true } } } });
      if (!target) invisible();
      if (target.student) invalid('account_id', '学生账号请在学生档案办理启停');
    };
    return this.workflow.run(req, { accountId: id, checkAccess }, 'tech', async (tx, _row, actor) => {
      const input = validate<AccountStatusPatch>('account_status_patch', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写启停原因');
      const row = await tx.account.findUniqueOrThrow({ where: { id }, select: fields });
      checkVersion(row.version, input.expected_version);
      const active = input.status === 'active';
      const next = active === row.active ? row : await tx.account.update({
        where: { id }, data: { active, version: { increment: 1 } }, select: fields,
      });
      await requirePermanentAdmin(tx);
      if (active === row.active) return summary(next);
      if (!active) await tx.httpSession.deleteMany({ where: { account_id: id } });
      await audit(tx, { actor_id: actor.account_id, action: 'set_account_status', resource_type: 'account',
        resource_id: id, reason, before: { status: row.active ? 'active' : 'inactive', version: row.version },
        after: { status: input.status, version: next.version } });
      return summary(next);
    });
  }

  @Get(':id/roles')
  @Header('Cache-Control', 'no-store')
  async roles(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.read(req.actor, id);
    return envelope({ account_id: id, version: row.roles_version, roles: grants(row) });
  }

  @Put(':id/roles')
  async changeOrganizer(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const checkAccess = async (tx: Tx) => {
      const eligible = await tx.account.findFirst({ where: {
        id, student: { isNot: null }, roles: { some: { role: 'student' }, none: { role: { in: ['reviewer', 'tech_admin'] } } },
      }, select: { id: true } });
      if (!eligible) denied();
    };
    return this.workflow.run(req, { accountId: id, checkAccess }, 'review', async (tx, _activity, actor) => {
      const input = validate<RoleReplacement>('role_replacement', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写办理原因');
      if (new Set(input.roles.map(grant => grant.role)).size !== input.roles.length)
        invalid('roles', '同一角色不能重复');
      const row = await tx.account.findUniqueOrThrow({ where: { id }, select: fields });
      checkVersion(row.roles_version, input.expected_version);
      const before = grants(row);
      const student = input.roles.find(grant => grant.role === 'student');
      const unchanged = before.find(grant => grant.role === 'student')!;
      if (!student || (student.expires_at ? new Date(student.expires_at).toISOString() : undefined) !== unchanged.expires_at
        || input.roles.some(grant => grant.role !== 'student' && grant.role !== 'organizer')) denied();
      const next = input.roles.find(grant => grant.role === 'organizer');
      const current = before.find(grant => grant.role === 'organizer');
      const expiry = next?.expires_at ? new Date(next.expires_at) : null;
      if (expiry && expiry.getTime() <= Date.now()) invalid('roles', '到期时间必须晚于当前时间');
      if (!!current === !!next && current?.expires_at === expiry?.toISOString())
        return { account_id: id, version: row.roles_version, roles: before };
      if (next) await tx.roleGrant.upsert({
        where: { account_id_role: { account_id: id, role: 'organizer' } },
        create: { account_id: id, role: 'organizer', expires_at: expiry }, update: { expires_at: expiry },
      });
      else await tx.roleGrant.delete({ where: { account_id_role: { account_id: id, role: 'organizer' } } });
      const updated = await tx.account.update({ where: { id }, data: { roles_version: { increment: 1 } }, select: fields });
      const after = grants(updated);
      await audit(tx, { actor_id: actor.account_id, resource_type: 'account', resource_id: id,
        action: 'set_account_roles', reason, before: { roles: before }, after: { roles: after } });
      return { account_id: id, version: updated.roles_version, roles: after };
    });
  }
}

@Controller('admin/staff-accounts')
@UseGuards(StaffGuard)
export class StaffAccountsController {
  constructor(private workflow: Workflow) {}

  @Post()
  create(@Req() req: SessionRequest, @Body() body: unknown) {
    return this.workflow.run(req, null, 'tech', async (tx, _row, actor) => {
      const input = validate<StaffAccountInput>('staff_account_input', body);
      const username = input.username.trim(), display_name = input.display_name.trim(), reason = input.reason.trim();
      if (!username) invalid('username', '请填写登录账号');
      if (!display_name) invalid('display_name', '请填写姓名');
      if (!reason) invalid('reason', '请填写创建原因');
      let row: Row;
      try {
        row = await tx.account.create({ data: {
          username, display_name, password_hash: null, roles: { create: { role: input.role } },
        }, select: fields });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new BusinessError(409, 'conflict', '该登录账号已被使用，请核对');
        throw e;
      }
      const roles = grants(row);
      await audit(tx, { actor_id: actor.account_id, action: 'create_staff_account', resource_type: 'account',
        resource_id: row.id, reason, before: { exists: false }, after: { status: 'active', credential_pending: true, roles } });
      return { account_id: row.id, version: row.roles_version, roles };
    });
  }
}
