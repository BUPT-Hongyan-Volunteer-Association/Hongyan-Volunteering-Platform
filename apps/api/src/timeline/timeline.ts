import { parseActivityFilters, publishedActivityFilter } from '../activities/filters.js';
import { slots } from '../activities/schedule.js';
import { localDate, serviceDates } from '@hongyan/contracts/activity';
import { createHash } from 'node:crypto';
import type {
  Activity,
  ActivityInput,
  TimelineActivity,
  TimelineActivityPage,
} from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../database.js';
import type { Actor } from '../auth/session.guard.js';
import { invalid } from '../http.js';
import { managedScope } from '../activities/read.js';
import { activityViews } from '../activities/list.js';

export type TimelineScope = 'public' | 'mine' | 'managed' | 'all';
const scopes: TimelineScope[] = ['public', 'mine', 'managed', 'all'];
const overlappingStatuses = ['published', 'completed'];
type Query = Record<string, string>;

/** 契约：活动 ID 标准小写 UUID 字符串的 UTF-8 字节 FNV-1a 32 位无符号散列模 6。 */
export function colorIndex(id: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id.toLowerCase()))
    hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) % 6;
}

type Period = { activityId: string; start: number; end: number };

/** 仅在本人已录取活动的实际服务时间相交时标记重叠。 */
async function plannedOverlapIds(db: Database, studentId: string, from: number, to: number) {
  const activities = await db.activity.findMany({
    where: {
      status: { in: overlappingStatuses }, published_revision: { not: null },
      registrations: { some: { student_id: studentId, status: 'accepted' } },
    },
    include: { revisions: { where: { revision_state: 'approved' } } },
  });
  const periods: Period[] = [];
  for (const activity of activities) {
    const revision = activity.revisions.find(r => r.revision === activity.published_revision);
    if (!revision) continue;
    for (const slot of slots((revision.content as unknown as ActivityInput).schedule)) {
      const start = Date.parse(slot.starts_at), end = Date.parse(slot.ends_at);
      if (start < to && end > from) periods.push({ activityId: activity.id, start, end });
    }
  }
  const overlapping = new Set<string>();
  periods.sort((a, b) => a.start - b.start);
  let active: Period[] = [];
  for (const period of periods) {
    active = active.filter(other => other.end > period.start);
    for (const other of active) {
      if (other.activityId === period.activityId) continue;
      overlapping.add(other.activityId);
      overlapping.add(period.activityId);
    }
    active.push(period);
  }
  return overlapping;
}

function toActivity(view: Activity, scope: TimelineScope, overlaps?: Set<string>): TimelineActivity | null {
  const { duration_start_date, duration_end_date } = serviceDates(view.schedule);
  if (!duration_start_date || !duration_end_date) return null;
  return {
    activity_id: view.id,
    activity_code: view.activity_code,
    title: view.title,
    status: view.status,
    revision_state: view.revision_state,
    schedule_revision: view.schedule_revision,
    registration_phase: view.registration_phase ?? 'unavailable',
    ...(view.campus && { campus: view.campus }),
    location: view.location ?? '',
    capacity: view.capacity ?? 0,
    ...(scope === 'public' && view.status === 'published' && view.registration_closes_at && { registration_closes_at: view.registration_closes_at }),
    ...(view.owner_account_id && { owner_account_id: view.owner_account_id }),
    owner_display_name: view.owner_display_name,
    color_index: colorIndex(view.id),
    duration_start_date, duration_end_date,
    ...(overlaps && { has_planned_overlap: overlaps.has(view.id) }),
    is_ongoing: view.is_ongoing,
    ...((scope === 'managed' || scope === 'all') && {
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
  let nextStart = Infinity, lastEnd = -Infinity;
  function outsideWindow(start: number, end: number) {
    if (start >= to) nextStart = Math.min(nextStart, start);
    if (end <= from) lastEnd = Math.max(lastEnd, end);
  }
  const views = await activityViews(db, where, management ? revision : 'public', q, { studentId, range, outsideWindow }, (a) => {
    digest.update(JSON.stringify(toActivity(a, scope)));
  });
  const overlaps =
    scope === 'mine' && studentId
      ? await plannedOverlapIds(db, studentId, from, to)
      : undefined;
  const owners = management ? await ownerChoices(db, actor, scope) : undefined;
  const items = views.items
    .map((view) => toActivity(view, scope, overlaps))
    .filter((item): item is TimelineActivity => item !== null);
  const suggestedTime = Number.isFinite(nextStart) ? nextStart : lastEnd - 1;
  const page = {
    ...(views.total === 0 && Number.isFinite(suggestedTime) && { suggested_date: localDate(suggestedTime) }),
    items,
    total: views.total,
    page: views.page,
    page_size: views.page_size,
    state_evaluated_at: views.now.toISOString(),
    ...(owners && { owner_options: owners }),
  };
  if (overlaps) digest.update(JSON.stringify([...overlaps].sort()));
  return { page, rangeKey: digest.digest('hex') };
}
