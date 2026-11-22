import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Prisma } from './generated/prisma/client.js';
import { pagination, staff } from './activities/read.js';
import type { SessionRequest } from './auth/session.guard.js';
import { Database } from './database.js';
import { denied, envelope, invalid } from './http.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const snapshot = { isolationLevel: 'RepeatableRead' } as const;

function text(value: Prisma.JsonValue | null) {
  if (value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

@Controller()
export class AuditController {
  constructor(private db: Database) {}

  @Get('admin/audit-events')
  async list(@Req() req: SessionRequest, @Query() query: Record<string, string>) {
    if (!staff(req.actor)) denied();
    for (const field of ['actor_id', 'resource_id'])
      if (query[field] !== undefined && !uuidPattern.test(query[field]))
        invalid(field, '标识格式错误');
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);
    if (from && Number.isNaN(from.getTime())) invalid('from', '起始时间格式错误');
    if (to && Number.isNaN(to.getTime())) invalid('to', '结束时间格式错误');
    if (from && to && from > to) invalid('to', '结束时间须等于或晚于起始时间');
    const { page, page_size, skip } = pagination(query);
    const where: Prisma.AuditEventWhereInput = {
      ...(query.actor_id && { actor_id: query.actor_id }),
      ...(query.resource_id && { resource_id: query.resource_id }),
      ...(from || to ? { created_at: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
    };
    const result = await this.db.$transaction(async (tx) => {
      const total = await tx.auditEvent.count({ where });
      const rows = skip < total
        ? await tx.auditEvent.findMany({
            where,
            orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
            skip,
            take: page_size,
          })
        : [];
      return {
        items: rows.map((row) => ({
          id: row.id,
          actor_id: row.actor_id,
          action: row.action,
          resource_type: row.resource_type,
          resource_id: row.resource_id,
          ...(row.reason && { reason: row.reason }),
          ...(text(row.before) !== undefined && { before: text(row.before) }),
          ...(text(row.after) !== undefined && { after: text(row.after) }),
          created_at: row.created_at.toISOString(),
        })),
        page,
        page_size,
        total,
      };
    }, snapshot);
    return envelope(result);
  }
}
