import type { Activity as View, ActivityInput } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Actor } from '../auth/session.guard.js';
import { publishedRevision, workingRevision } from './revisions.js';
import { slots } from './schedule.js';
import { denied, invalid } from '../http.js';

export const staff = (a: Actor) => a.roles.includes('reviewer') || a.roles.includes('tech_admin');
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
export function registrationScope(actor: Actor, scope?: string) {
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
export function project(
  row: Omit<LoadedActivity, 'reviews'> & {
    reviews: Pick<LoadedActivity['reviews'][number], 'id' | 'status'>[];
  },
  scope: 'working' | 'published',
  now: Date,
  management: boolean,
): View | null {
  const published = publishedRevision(row);
  const rev = scope === 'published' ? published : workingRevision(row);
  if (!rev) return null;
  const input = rev.content as unknown as ActivityInput;
  const times = slots(input.schedule);
  const live =
    rev === published
      ? times
      : published
        ? slots((published.content as unknown as ActivityInput).schedule)
        : [];
  const t = now.getTime();
  const item: View = {
    ...input,
    id: row.id,
    version: row.version,
    activity_code: row.activity_code,
    status: row.status as View['status'],
    owner_display_name: row.members[0].account.display_name,
    owner_account_id: row.members[0].account_id,
    starts_at: new Date(Math.min(...times.map((s) => Date.parse(s.starts_at)))).toISOString(),
    ends_at: new Date(Math.max(...times.map((s) => Date.parse(s.ends_at)))).toISOString(),
    registration_phase:
      row.status !== 'published'
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
      row.status === 'published' &&
      live.some((s) => Date.parse(s.starts_at) <= t && t < Date.parse(s.ends_at)),
    ...(management && {
      has_pending_review: row.reviews.some((r) => r.status === 'pending'),
      current_review_id: row.reviews.find((r) => r.status === 'pending')?.id,
    }),
    ...(row.published_revision !== null && { published_revision: row.published_revision }),
  };
  if (!management) delete item.group_join_instructions;
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
