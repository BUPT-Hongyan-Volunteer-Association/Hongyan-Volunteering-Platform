import type { Tx } from '../activities/workflow.js';
import { Prisma } from '../generated/prisma/client.js';
import { BusinessError } from '../http.js';
import type { Actor } from './session.guard.js';

export function managedAccountScope(actor: Actor): Prisma.AccountWhereInput {
  return actor.roles.includes('tech_admin') ? {} : {
    student: { isNot: null },
    roles: { none: { role: { in: ['reviewer', 'tech_admin'] } } },
  };
}

const permanentAdmins = Prisma.sql`
  SELECT a.id FROM account a JOIN role_grant g ON g.account_id = a.id
  WHERE a.active AND a.password_hash ~ '^[^:]+:[0-9a-fA-F]{128}$'
    AND g.role = 'tech_admin' AND g.expires_at IS NULL`;

// Call before the change, with the target account already locked by Workflow.
export async function guardPermanentAdminLoss(tx: Tx, accountId: string) {
  const locked = await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended('account:permanent-tech-admin', 0))
    FROM (${permanentAdmins}) admins WHERE admins.id = ${accountId}::uuid`;
  if (locked === 0) return;
  // A separate statement sees the outcome of the preceding lock holder.
  const [result] = await tx.$queryRaw<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM (${permanentAdmins}) admins WHERE admins.id <> ${accountId}::uuid) AS available`;
  if (!result.available) throw new BusinessError(409, 'invalid_state', '须保留至少一个可登录且角色长期有效的技术管理员');
}
