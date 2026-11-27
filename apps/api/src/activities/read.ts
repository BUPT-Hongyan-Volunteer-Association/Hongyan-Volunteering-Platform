import { activityBounds } from '@hongyan/contracts/activity';
import type { Activity as View, ActivityInput } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Actor } from '../auth/session.guard.js';
import { denied, invalid } from '../http.js';

export const staff = (a: Actor) => a.roles.includes('reviewer') || a.roles.includes('tech_admin');
export const eligibleOrganizer = (now: Date): Prisma.AccountWhereInput => ({
  active: true, password_hash: { not: null }, roles: { some: { role: 'organizer', OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
});
export function teamManagerScope(actor: Actor): Prisma.ActivityWhereInput {
  if (staff(actor)) return {};
  if (!actor.roles.includes('organizer')) denied();
  return { members: { some: { account_id: actor.account_id, member_role: 'owner' } } };
}
export function managedScope(
  actor: Actor,
  scope = staff(actor) ? 'all' : 'managed',
): Prisma.ActivityWhereInput {
  if (scope === 'all') {
    if (!staff(actor)) denied();
    return {};
  }
  if (scope !== 'managed') invalid('scope', '管理范围无效');
  if (!actor.roles.includes('organizer')) denied();
  return { members: { some: { account_id: actor.account_id } } };
}
export function workspaceScope(actor: Actor, scope?: string) {
  return managedScope(actor, scope ?? (actor.roles.includes('organizer') ? 'managed' : undefined));
}

export const includeView = {
  revisions: true,
  reviews: true,
  members: {
    where: { member_role: 'owner' },
    include: { account: { select: { display_name: true } } },
  },
} as const;
export type LoadedActivity = Prisma.ActivityGetPayload<{ include: typeof includeView }>;

/** 列表、日程与管理详情共用的读取视图：活动行加已取回的版本快照。 */
export type PageRow = {
  id: string;
  activity_code: string;
  status: string;
  version: number;
  working_revision: number;
  published_revision: number | null;
  members: LoadedActivity['members'];
  revisions: LoadedActivity['revisions'];
  reviews: { id: string; status: string }[];
  registrations?: { status: string }[];
};

export function publishedRevision(row: Pick<PageRow, 'published_revision' | 'revisions'>) {
  return row.revisions.find(
    (r) => r.revision === row.published_revision && r.revision_state === 'approved',
  );
}

export function workingRevision(
  row: Pick<PageRow, 'working_revision' | 'published_revision' | 'revisions'>,
) {
  // The write pointer stays at the latest revision, including after rejection or withdrawal.
  const latest = row.revisions.find((r) => r.revision === row.working_revision);
  if (latest?.revision_state === 'pending_review' || latest?.revision_state === 'draft')
    return latest;
  return publishedRevision(row) ?? latest;
}

export function project(
  row: PageRow,
  scope: 'working' | 'published' | 'public' | 'public-detail',
  now: Date,
): View | null {
  const management = scope === 'working' || scope === 'published';
  const published = publishedRevision(row);
  const rev = scope === 'working' ? workingRevision(row) : published;
  if (!rev) return null;
  const input = rev.content as unknown as ActivityInput;
  const schedule = (published?.content as unknown as ActivityInput | undefined)?.schedule;
  const t = now.getTime();
  const bounds = activityBounds(schedule);
  const item: View = {
    ...input,
    id: row.id,
    version: row.version,
    activity_code: row.activity_code,
    status: row.status as View['status'],
    owner_display_name: row.members[0].account.display_name,
    owner_account_id: row.members[0].account_id,
    registration_phase:
      row.status !== 'published' || !input.registration_opens_at || !input.registration_closes_at
        ? 'unavailable'
        : t < Date.parse(input.registration_opens_at)
          ? 'not_open'
          : t < Date.parse(input.registration_closes_at)
            ? 'open'
            : 'closed',
    schedule_revision: rev.revision,
    revision_state: rev.revision_state as View['revision_state'],
    state_evaluated_at: now.toISOString(),
    is_ongoing:
      row.status === 'published' && !!bounds && bounds.start <= t && t < bounds.end,
    ...(management && {
      has_pending_review: row.reviews.some((r) => r.status === 'pending'),
      current_review_id: row.reviews.find((r) => r.status === 'pending')?.id,
    }),
    ...(row.published_revision !== null && { published_revision: row.published_revision }),
  };
  if (!management) {
    const own = row.registrations?.[0];
    if (own) item.my_registration_status = own.status as View['my_registration_status'];
    if (scope !== 'public-detail' || own?.status !== 'accepted') {
      delete item.group_join_instructions;
      delete item.group_qr_id;
    }
  }
  return item;
}

type Query = Record<string, string>;
export function pagination(query: Query) {
  const page = Number(query.page ?? 1),
    page_size = Number(query.page_size ?? 20);
  if (!Number.isSafeInteger(page) || page < 1) invalid('page', '页码必须为正整数');
  if (!Number.isInteger(page_size) || page_size < 1 || page_size > 100)
    invalid('page_size', '每页显示 1 至 100 条');
  return { page, page_size, skip: (page - 1) * page_size };
}
