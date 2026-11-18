import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, ActivityRevision, ActivityReview } from '../generated/prisma/client.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, expired, invalid, invisible } from '../http.js';
import { includeView, managedScope, project, staff, type LoadedActivity } from './read.js';

export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new BusinessError(409, 'version_conflict', '版本已更新，请刷新后复核');
}
export function wrongState(): never {
  throw new BusinessError(409, 'invalid_state', '当前状态不允许此操作');
}
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export function snapshot(r: ActivityRevision) {
  return {
    activity_id: r.activity_id,
    revision: r.revision,
    revision_state: r.revision_state,
    content: r.content,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    ...(r.approved_at && { approved_at: r.approved_at.toISOString() }),
  };
}
function differences(
  before: unknown,
  after: unknown,
  field_path = '',
): { field_path: string; before_value: string; after_value: string }[] {
  if (stable(before) === stable(after)) return [];
  if (
    after &&
    typeof after === 'object' &&
    !Array.isArray(after) &&
    (before == null || (typeof before === 'object' && !Array.isArray(before)))
  ) {
    const left = before as Record<string, unknown> | null,
      right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right)])]
      .sort()
      .flatMap((k) => differences(left?.[k], right[k], field_path ? field_path + '.' + k : k));
  }
  return [{ field_path, before_value: stable(before ?? null), after_value: stable(after ?? null) }];
}
export function reviewView(row: LoadedActivity, r: ActivityReview) {
  const current = row.revisions.find((v) => v.revision === r.revision)!;
  const before = row.revisions.find((v) => v.revision === r.previous_revision);
  return reviewResponse(r, current, before);
}
export function reviewResponse(
  r: ActivityReview,
  current: ActivityRevision,
  before?: ActivityRevision,
) {
  return {
    id: r.id,
    version: r.version,
    activity_id: r.activity_id,
    revision: r.revision,
    status: r.status,
    submitted_by: r.submitted_by,
    created_at: r.created_at.toISOString(),
    ...(r.reviewed_by && { reviewed_by: r.reviewed_by }),
    ...(r.reason && { reason: r.reason }),
    ...(r.reviewed_at && { reviewed_at: r.reviewed_at.toISOString() }),
    snapshot: snapshot(current),
    ...(before && { previous_published_snapshot: snapshot(before) }),
    changes: differences(before?.content, current.content),
  };
}
export function detail(row: LoadedActivity) {
  const current = row.reviews.find((r) => r.revision === row.working_revision);
  const working = row.revisions.find((r) => r.revision === row.working_revision)!;
  const published = row.revisions.find((r) => r.revision === row.published_revision);
  return {
    activity: project(row, 'working', new Date(), true)!,
    working_snapshot: snapshot(working),
    ...(current && { current_review: reviewView(row, current) }),
    ...(published && { published_snapshot: snapshot(published) }),
  };
}

export type Tx = Prisma.TransactionClient;
export type Target = { activityId: string } | { reviewId: string } | null;
@Injectable()
export class Workflow {
  constructor(private db: Database) {}
  async run(
    req: SessionRequest,
    target: Target,
    access: 'create' | 'manage' | 'review',
    execute: (tx: Tx, row: LoadedActivity | null) => Promise<unknown>,
  ) {
    const key = req.get('Idempotency-Key');
    if (!key || key.length < 8 || key.length > 100)
      invalid('Idempotency-Key', '幂等键长度须为 8 至 100');
    const account_id = req.actor.account_id,
      method = req.method,
      path = req.path;
    const identity = { account_id, method, path, key };
    const digest = createHash('sha256')
      .update(stable(req.body ?? {}))
      .digest('hex');
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${stable(identity)},0))`;
      let row: LoadedActivity | null = null;
      if (target) {
        const id =
          'activityId' in target
            ? target.activityId
            : (await tx.activityReview.findUnique({ where: { id: target.reviewId } }))?.activity_id;
        if (!id) invisible();
        await tx.$queryRaw`SELECT id FROM activity WHERE id=${id}::uuid FOR UPDATE`;
        row = await tx.activity.findUnique({ where: { id }, include: includeView });
        if (!row) invisible();
      }
      const account = await tx.account.findFirst({
        where: {
          id: account_id,
          active: true,
          must_change_password: false,
          sessions: { some: { id_hash: req.sessionHash, expires_at: { gt: new Date() } } },
        },
        include: {
          roles: { where: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
        },
      });
      if (!account) expired();
      const actor = { ...req.actor, roles: account.roles.map((r) => r.role) };
      if (access === 'create' && !actor.roles.includes('organizer')) denied();
      if (access === 'review' && !staff(actor)) denied();
      if (
        access === 'manage' &&
        row &&
        !(await tx.activity.findFirst({
          where: { id: row.id, ...managedScope(actor) },
          select: { id: true },
        }))
      )
        invisible();
      const cached = await tx.commandReceipt.findUnique({
        where: { account_id_method_path_key: identity },
      });
      if (cached) {
        if (cached.digest !== digest)
          throw new BusinessError(409, 'conflict', '同一幂等键的请求内容已变化');
        return cached.response;
      }
      const response = json(envelope(await execute(tx, row)));
      await tx.commandReceipt.create({ data: { ...identity, digest, response } });
      return response;
    });
  }
}
