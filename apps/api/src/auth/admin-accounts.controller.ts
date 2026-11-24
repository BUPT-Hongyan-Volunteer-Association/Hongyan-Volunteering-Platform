import { guardPermanentAdminLoss, managedAccountScope } from './account-access.js';
import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AccountStatusPatch, ReasonAction, RoleReplacement, StaffAccountInput } from '@hongyan/contracts/types';
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
  student: { select: { id: true, version: true } },
  roles: { select: { role: true, expires_at: true }, orderBy: { role: 'asc' } },
} satisfies Prisma.AccountSelect;
type Row = Prisma.AccountGetPayload<{ select: typeof fields }>;

function grants(row: Row) {
  return row.roles.map(({ role, expires_at }) => ({
    role, ...(expires_at && { expires_at: expires_at.toISOString() }),
  }));
}

function summary(row: Row) {
  return {
    account_id: row.id, version: row.version, username: row.username, display_name: row.display_name,
    status: row.active ? 'active' : 'inactive', ...(row.student && { student_id: row.student.id, student_version: row.student.version }),
    ...(row.password_hash === null && { credential_pending: true }), roles: grants(row),
  };
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
      managedAccountScope(req.actor),
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
      this.db.account.findFirst({ where: { id, ...managedAccountScope(actor) }, select: fields }),
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
      if (active === row.active) return summary(row);
      if (!active) await guardPermanentAdminLoss(tx, id);
      const next = await tx.account.update({
        where: { id }, data: { active, version: { increment: 1 } }, select: fields,
      });
      if (!active) await tx.httpSession.deleteMany({ where: { account_id: id } });
      await audit(tx, { actor_id: actor.account_id, action: 'set_account_status', resource_type: 'account',
        resource_id: id, reason, before: { status: row.active ? 'active' : 'inactive', version: row.version },
        after: { status: input.status, version: next.version } });
      return summary(next);
    });
  }

  @Post(':id/password-reset')
  @HttpCode(200)
  resetPassword(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const checkAccess = async (tx: Tx, actor: Actor) => {
      const visible = await tx.account.count({ where: { id, ...managedAccountScope(actor) } });
      if (!visible) return actor.roles.includes('tech_admin') ? invisible() : denied();
    };
    return this.workflow.run(req, { accountId: id, checkAccess }, 'review', async (tx, _row, actor) => {
      const input = validate<ReasonAction>('reason_action', body);
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写核验后的重置原因');
      const account = await tx.account.findUniqueOrThrow({ where: { id }, select: { version: true, password_hash: true } });
      checkVersion(account.version, input.expected_version);
      if (account.password_hash === null)
        throw new BusinessError(409, 'invalid_state', '该账号的凭证已待发放，请重新核对');
      await guardPermanentAdminLoss(tx, id);
      const { version } = await tx.account.update({ where: { id },
        data: { password_hash: null, must_change_password: true, version: { increment: 1 } }, select: { version: true } });
      await tx.httpSession.deleteMany({ where: { account_id: id } });
      await audit(tx, { actor_id: actor.account_id, action: 'reset_password', resource_type: 'account', resource_id: id,
        reason, before: { credential_pending: false, version: account.version }, after: { credential_pending: true, version } });
      return { completed: true, resource_id: id, version };
    });
  }

  @Get(':id/roles')
  @Header('Cache-Control', 'no-store')
  async roles(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.read(req.actor, id);
    return envelope({ account_id: id, version: row.roles_version, roles: grants(row) });
  }

  @Put(':id/roles')
  async setRoles(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    let row: Row, input: RoleReplacement;
    const checkAccess = async (tx: Tx, actor: Actor) => {
      const technical = actor.roles.includes('tech_admin');
      const target = await tx.account.findFirst({ where: { id, ...managedAccountScope(actor) }, select: fields });
      if (!target) return technical ? invisible() : denied();
      row = target;
      input = validate<RoleReplacement>('role_replacement', body);
      const student = row.roles.find(g => g.role === 'student');
      const requestedStudent = input.roles.find(g => g.role === 'student');
      if (!technical && (!student || input.roles.some(g => g.role !== 'student' && g.role !== 'organizer'))) denied();
      // A role change must preserve the student's underlying identity.
      if (row.student && student && (!requestedStudent ||
        (student.expires_at?.getTime() ?? null) !== (requestedStudent.expires_at ? Date.parse(requestedStudent.expires_at) : null))) denied();
      if (!row.student && requestedStudent && !student) invalid('roles', '学生身份须关联学生档案');
    };
    return this.workflow.run(req, { accountId: id, checkAccess }, 'review', async (tx, _activity, actor) => {
      const reason = input.reason.trim();
      if (!reason) invalid('reason', '请填写办理原因');
      if (new Set(input.roles.map(grant => grant.role)).size !== input.roles.length)
        invalid('roles', '同一角色不能重复');
      checkVersion(row.roles_version, input.expected_version);
      const before = grants(row);
      const removed = before.filter(g => !input.roles.some(next => next.role === g.role)).map(g => g.role);
      const changed = input.roles.map(g => ({ role: g.role, expires_at: g.expires_at ? new Date(g.expires_at) : null }))
        .filter(g => {
          const previous = row.roles.find(old => old.role === g.role);
          return !previous || previous.expires_at?.getTime() !== g.expires_at?.getTime();
        });
      if (!removed.length && !changed.length) return { account_id: id, version: row.roles_version, roles: before };
      if (changed.some(g => g.expires_at && g.expires_at.getTime() <= Date.now()))
        invalid('roles', '到期时间必须晚于当前时间');
      if (removed.includes('tech_admin') || changed.some(g => g.role === 'tech_admin' && g.expires_at !== null))
        await guardPermanentAdminLoss(tx, id);
      if (removed.length) await tx.roleGrant.deleteMany({ where: { account_id: id, role: { in: removed } } });
      for (const grant of changed) await tx.roleGrant.upsert({
        where: { account_id_role: { account_id: id, role: grant.role } },
        create: { account_id: id, ...grant }, update: { expires_at: grant.expires_at },
      });
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
