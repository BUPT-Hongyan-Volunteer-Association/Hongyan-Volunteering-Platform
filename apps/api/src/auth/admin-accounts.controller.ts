import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Prisma, Role } from '../generated/prisma/client.js';
import { pagination } from '../activities/read.js';
import { Database } from '../database.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import { StaffGuard } from '../students/staff.guard.js';
import type { Actor, SessionRequest } from './session.guard.js';

const fields = {
  id: true, username: true, display_name: true, active: true, version: true, roles_version: true,
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
    roles: grants(row),
  };
}

@Controller('admin/accounts')
@UseGuards(StaffGuard)
export class AdminAccountsController {
  constructor(private db: Database) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: SessionRequest, @Query() query: Record<string, string>) {
    const { page, page_size, skip } = pagination(query);
    const { q, status, role } = query;
    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) invalid('q', '查询条件最多 100 字');
    if (status !== undefined && !['active', 'inactive'].includes(status)) invalid('status', '账号状态无效');
    if (role !== undefined && (typeof role !== 'string' || !Object.hasOwn(Role, role))) invalid('role', '角色无效');
    const where: Prisma.AccountWhereInput = { AND: [
      scope(req.actor),
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

  @Get(':id/roles')
  @Header('Cache-Control', 'no-store')
  async roles(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.read(req.actor, id);
    return envelope({ account_id: id, version: row.roles_version, roles: grants(row) });
  }
}
