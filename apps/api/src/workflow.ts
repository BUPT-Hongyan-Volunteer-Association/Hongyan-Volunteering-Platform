import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { studentId, type Actor, type SessionRequest } from './auth/session.guard.js';
import { Database, json, stable, type Tx } from './database.js';
import { BusinessError, denied, envelope, expired, invalid, invisible } from './http.js';
import { includeView, managedScope, staff, teamManagerScope, workspaceScope, type LoadedActivity } from './activities/read.js';

export type Reauthorize = () => Promise<Actor>;
export type Target =
  | { activityId: string }
  | { teamId: string }
  | { activityIds: (tx: Tx) => Promise<string[]> }
  | { reviewId: string }
  | { requestId: string }
  | { registrationId: string }
  | null;
type Access = 'create' | 'manage' | 'review' | 'apply' | 'workspace' | 'self' | 'team' | 'tech' | 'export';
type CommandArgs = [tx: Tx, row: LoadedActivity | null, actor: Actor, reauthorize: Reauthorize];
type Write = () => Promise<unknown>;

async function targetActivityId(tx: Tx, target: Exclude<Target, { activityIds: unknown } | { teamId: string } | null>) {
  if ('activityId' in target) return target.activityId;
  if ('requestId' in target) {
    const request = await tx.exitRequest.findUnique({ where: { id: target.requestId }, select: { registration: { select: { activity_id: true } } } });
    if (!request) invisible();
    return request.registration.activity_id;
  }
  const reference =
    'reviewId' in target
      ? await tx.activityReview.findUnique({
          where: { id: target.reviewId },
          select: { activity_id: true },
        })
      : await tx.registration.findUnique({
          where: { id: target.registrationId },
          select: { activity_id: true },
        });
  if (!reference) invisible();
  return reference.activity_id;
}
@Injectable()
export class Workflow {
  constructor(private db: Database) {}
  run(
    req: SessionRequest,
    target: Target,
    // 'self' 用于本人资源操作（如通知已读/确认），不做活动范围校验。
    access: Access,
    execute: (...args: CommandArgs) => Promise<unknown>,
    scope?: string,
    commandInput?: unknown,
  ) {
    return this.runCommand(req, target, access, (...args) => () => execute(...args), scope, commandInput);
  }

  runAccount<T>(
    req: SessionRequest, accountId: string, access: 'tech' | 'review',
    checkAccess: (tx: Tx, actor: Actor) => Promise<T>,
    execute: (tx: Tx, actor: Actor, checked: T) => Promise<unknown>,
  ) {
    return this.runCommand(req, { accountId }, access, async (tx, _row, actor) => {
      const checked = await checkAccess(tx, actor);
      return () => execute(tx, actor, checked);
    });
  }

  private async runCommand(
    req: SessionRequest, target: Target | { accountId: string }, access: Access,
    prepare: (...args: CommandArgs) => Write | Promise<Write>,
    scope?: string,
    commandInput: unknown = req.body ?? {},
  ) {
    const key = req.get('Idempotency-Key');
    if (!key || key.length < 8 || key.length > 100)
      invalid('Idempotency-Key', '幂等键长度须为 8 至 100');
    const account_id = req.actor.account_id,
      method = req.method,
      path = req.path;
    const identity = { account_id, method, path, key };
    const digest = createHash('sha256')
      .update(stable(commandInput))
      .digest('hex');
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${stable(identity)},0))`;
      let row: LoadedActivity | null = null;
      let ids: string[] | undefined;
      if (target && 'accountId' in target) {
        await tx.$queryRaw`SELECT id FROM account WHERE id IN (${target.accountId}::uuid, ${account_id}::uuid) ORDER BY id FOR UPDATE`;
      } else if (target && 'teamId' in target) {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM activity WHERE id=${target.teamId}::uuid FOR UPDATE`;
        if (!locked.length) invisible();
      } else if (target && 'activityIds' in target) {
        ids = [...new Set(await target.activityIds(tx))];
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM activity WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        if (!ids.length || locked.length !== ids.length) invisible();
      } else if (target) {
        const id = await targetActivityId(tx, target);
        // Enrollment, promotion and restoration compete for the same item capacity.
        await tx.$queryRaw`SELECT id FROM activity WHERE id=${id}::uuid FOR UPDATE`;
        row = await tx.activity.findUnique({ where: { id }, include: includeView });
        if (!row) invisible();
      }
      if (access === 'tech' && !target)
        await tx.$queryRaw`SELECT id FROM account WHERE id=${account_id}::uuid FOR UPDATE`;
      const reauthorize: Reauthorize = async () => {
        const now = new Date();
        const account = await tx.account.findFirst({
          where: {
            id: account_id,
            active: true,
            must_change_password: false,
            sessions: { some: { id_hash: req.sessionHash, expires_at: { gt: now } } },
          },
          include: {
            student: { select: { id: true } },
            roles: { where: { OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
          },
        });
        if (!account) expired();
        const actor = { ...req.actor, roles: account.roles.map((r) => r.role) };
        if (access === 'apply' && (studentId(actor) !== account.student?.id || !row?.published_revision))
          invisible();
        if (access === 'self' && studentId(actor) !== account.student?.id) invisible();
        if (access === 'create' && !actor.roles.includes('organizer')) denied();
        if (access === 'tech' && !actor.roles.includes('tech_admin')) denied();
        if (access === 'review' && !staff(actor)) denied();
        if (access === 'team' && (!target || !('teamId' in target) || !await tx.activity.count({
          where: { id: target.teamId, ...teamManagerScope(actor) },
        }))) invisible();
        if (ids && access === 'manage' && await tx.activity.count({
          where: { id: { in: ids }, ...managedScope(actor) },
        }) !== ids.length) invisible();
        if ((access === 'manage' || access === 'workspace') && row && !await tx.activity.findFirst({
          where: { id: row.id, ...(access === 'workspace' ? workspaceScope(actor, scope) : managedScope(actor)) },
          select: { id: true },
        })) invisible();
        return actor;
      };
      const actor = await reauthorize();
      const write = await prepare(tx, row, actor, reauthorize);
      const cached = await tx.commandReceipt.findUnique({
        where: { account_id_method_path_key: identity },
      });
      if (cached) {
        if (cached.digest !== digest)
          throw new BusinessError(409, 'conflict', '同一幂等键的请求内容已变化');
        return cached.response;
      }
      const response = json(envelope(await write()));
      await tx.commandReceipt.create({ data: { ...identity, digest, response } });
      return response;
    });
  }
}
