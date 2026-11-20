import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { staff } from '../activities/read.js';
import { json, stable } from '../activities/workflow.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, expired, invalid } from '../http.js';

export type Tx = Prisma.TransactionClient;

/**
 * 写命令的统一入口：事务内重新核验会话与角色，幂等键相同且内容一致的请求复用首次结果，
 * 并在同一事务内落库与写入命令回执。
 */
export async function command<T>(
  db: Database,
  req: SessionRequest,
  payload: unknown,
  execute: (tx: Tx) => Promise<T>,
) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 100)
    invalid('Idempotency-Key', '幂等键长度须为 8 至 100');
  const identity = {
    account_id: req.actor.account_id,
    method: req.method,
    path: req.path,
    key,
  };
  const digest = createHash('sha256').update(stable(payload)).digest('hex');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${stable(identity)},0))`;
    const account = await tx.account.findFirst({
      where: {
        id: identity.account_id,
        active: true,
        must_change_password: false,
        sessions: { some: { id_hash: req.sessionHash, expires_at: { gt: new Date() } } },
      },
      include: { roles: { where: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } } },
    });
    if (!account) expired();
    const actor = { ...req.actor, roles: account.roles.map((grant) => grant.role) };
    if (!staff(actor)) denied();
    const cached = await tx.commandReceipt.findUnique({
      where: { account_id_method_path_key: identity },
    });
    if (cached) {
      if (cached.digest !== digest)
        throw new BusinessError(409, 'conflict', '同一幂等键的请求内容已变化');
      return cached.response;
    }
    const response = json(envelope(await execute(tx)));
    await tx.commandReceipt.create({ data: { ...identity, digest, response } });
    return response;
  });
}