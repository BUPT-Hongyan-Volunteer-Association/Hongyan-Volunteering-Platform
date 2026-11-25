import { parseActivityFilters, publishedActivityFilter } from '../activities/filters.js';
import { createHash } from 'node:crypto';
import type {
  Activity,
  ActivityInput,
  TimelineActivity,
  TimelineActivityPage,
  TimelineItem,
} from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../database.js';
import type { Actor } from '../auth/session.guard.js';
import { invalid } from '../http.js';
import { managedScope } from '../activities/read.js';
import { activityViews } from '../activities/list.js';
import { cachedSlots, slots } from '../activities/schedule.js';

export type TimelineScope = 'public' | 'mine' | 'managed' | 'all';
const scopes: TimelineScope[] = ['public', 'mine', 'managed', 'all'];
const overlappingStatuses = ['published', 'completed'];
function instant(milliseconds: number) {
  return new Date(milliseconds + 8 * 3600_000).toISOString().replace(/(?:\.000)?Z$/, '+08:00');
}

type Query = Record<string, string>;

/** 契约：活动 ID 标准小写 UUID 字符串的 UTF-8 字节 FNV-1a 32 位无符号散列模 6。 */
export function colorIndex(id: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id.toLowerCase()))
    hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) % 6;
}

type Plan = { activity_id: string; start: number; end: number };

/** 本人已录取活动的计划时段，仅用于窗口内的重叠提示。取消活动不计重叠。 */
async function plannedSlots(db: Database, studentId: string, from: number, to: number) {
  const rows = await db.activity.findMany({
    where: {
      status: { in: overlappingStatuses },
      published_revision: { not: null },
      registrations: { some: { student_id: studentId, status: 'accepted' } },
    },
    include: { revisions: { where: { revision_state: 'approved' } } },
  });
  const plan: Plan[] = [];
  for (const row of rows) {
    const revision = row.revisions.find((r) => r.revision === row.published_revision);
    if (!revision) continue;
    const { schedule } = revision.content as unknown as ActivityInput;
    for (const { start, end } of windowSlots(schedule, from, to))
      plan.push({ activity_id: row.id, start, end });
  }
  return plan;
}

function windowSlots(schedule: Activity['schedule'], from: number, to: number, expand = slots) {
  return expand(schedule)
    .map((slot) => ({ ...slot, start: Date.parse(slot.starts_at), end: Date.parse(slot.ends_at) }))
    .filter((slot) => slot.start < to && slot.end > from);
}

function toActivity(
  view: Activity,
  now: Date,
  from: number,
  to: number,
  management: boolean,
  expand: typeof slots,
  plan?: Plan[],
): TimelineActivity | null {
  const { schedule } = view;
  if (!schedule) return null;
  const segments = windowSlots(schedule, from, to, expand).sort((a, b) => a.start - b.start);
  if (!segments.length) return null;
  const others = overlappingStatuses.includes(view.status)
    ? plan?.filter((slot) => slot.activity_id !== view.id)
    : undefined;
  const items: TimelineItem[] = segments.map((slot) => {
    return {
      activity_id: view.id,
      activity_code: view.activity_code,
      title: view.title,
      starts_at: instant(slot.start),
      ends_at: instant(slot.end),
      status: view.status,
      occurrence_key: [view.id, view.schedule_revision, slot.starts_at].join('/'),
      schedule_revision: view.schedule_revision,
      schedule_type: schedule.schedule_type,
      revision_state: view.revision_state,
      ...(view.registration_phase && { registration_phase: view.registration_phase }),
      ...(view.location && { location: view.location }),
      ...(plan && {
        has_planned_overlap: others?.some((o) => slot.start < o.end && slot.end > o.start) ?? false,
      }),
    };
  });
  return {
    activity_id: view.id,
    activity_code: view.activity_code,
    title: view.title,
    status: view.status,
    revision_state: view.revision_state,
    schedule_revision: view.schedule_revision,
    schedule_type: schedule.schedule_type,
    registration_phase: view.registration_phase ?? 'unavailable',
    ...(view.campus && { campus: view.campus }),
    location: view.location ?? '',
    capacity: view.capacity ?? 0,
    ...(view.registration_closes_at && { registration_closes_at: view.registration_closes_at }),
    ...(view.owner_account_id && { owner_account_id: view.owner_account_id }),
    owner_display_name: view.owner_display_name,
    color_index: colorIndex(view.id),
    segments: items,
    ...(plan && { has_planned_overlap: items.some((item) => item.has_planned_overlap) }),
    is_ongoing: view.is_ongoing,
    state_evaluated_at: now.toISOString(),
    ...(management && {
      has_pending_review: view.has_pending_review === true,
      ...(view.current_review_id && { current_review_id: view.current_review_id }),
    }),
  };
}

/** 负责人候选按当前身份的授权范围独立计算，不受分页、窗口和筛选影响。 */
async function ownerChoices(db: Database, actor: Actor, scope: TimelineScope) {
  const rows = await db.activityMember.findMany({
    where: { member_role: 'owner', activity: managedScope(actor, scope) },
    select: { account_id: true, account: { select: { display_name: true } } },
    distinct: ['account_id'],
  });
  return rows
    .map((row) => ({ account_id: row.account_id, display_name: row.account.display_name }))
    .sort(
      (a, b) =>
        a.display_name.localeCompare(b.display_name, 'zh-Hans-CN') ||
        a.account_id.localeCompare(b.account_id),
    );
}

export async function timelinePage(
  db: Database,
  actor: Actor,
  q: Query,
): Promise<{ page: TimelineActivityPage; rangeKey: string }> {
  const scope = q.scope as TimelineScope;
  if (!scopes.includes(scope)) invalid('scope', '日程范围无效');
  const management = scope === 'managed' || scope === 'all';
  const range = parseActivityFilters(q, management, true);
  const { from, to } = range;
  const expand = cachedSlots();
  const revision = management ? (q.revision_scope === 'published' ? 'published' : 'working') : 'published';
  const studentId = scope === 'mine' ? actor.student?.id : undefined;

  let where: Prisma.ActivityWhereInput;
  if (scope === 'public' || scope === 'mine')
    where = publishedActivityFilter(scope, q.status, studentId);
  else
    where = {
      AND: [
        managedScope(actor, scope),
        {
          ...(revision === 'published' && { published_revision: { not: null } }),
          ...(q.status && { status: q.status }),
          ...(q.owner_account_id && {
            members: {
              some: { member_role: 'owner' as const, account_id: q.owner_account_id },
            },
          }),
        },
      ],
    };

  // 日程本就需要扫描全部匹配项以计数。只对当前身份可见的日程字段取摘要，排除请求时刻。
  const digest = createHash('sha256');
  const views = await activityViews(db, where, management ? revision : 'public', q, { studentId, range, expand }, (a) => {
    digest.update(JSON.stringify([
      a.id, a.activity_code, a.title, a.status, a.schedule_revision, a.revision_state, a.schedule,
      a.campus, a.location, a.capacity, a.registration_closes_at, a.registration_phase, a.is_ongoing,
      a.owner_account_id, a.owner_display_name, a.has_pending_review, a.current_review_id,
    ]));
  });
  const plan =
    scope === 'mine' && studentId
      ? await plannedSlots(db, studentId, from, to)
      : undefined;
  const owners = management ? await ownerChoices(db, actor, scope) : undefined;
  const items = views.items
    .map((view) => toActivity(view, views.now, from, to, management, expand, plan))
    .filter((item): item is TimelineActivity => item !== null);
  const page = {
    items,
    total: views.total,
    page: views.page,
    page_size: views.page_size,
    state_evaluated_at: views.now.toISOString(),
    ...(owners && { owner_options: owners }),
  };
  if (plan) {
    plan.sort((a, b) => a.activity_id.localeCompare(b.activity_id) || a.start - b.start || a.end - b.end);
    digest.update(JSON.stringify(plan));
  }
  return { page, rangeKey: digest.digest('hex') };
}
