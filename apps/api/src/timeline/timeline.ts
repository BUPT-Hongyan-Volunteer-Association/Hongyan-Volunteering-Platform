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
import { denied, invalid } from '../http.js';
import { managedScope } from '../activities/read.js';
import { activityViews } from '../activities/list.js';
import { slots } from '../activities/schedule.js';

export type TimelineScope = 'public' | 'mine' | 'managed' | 'all';
const scopes: TimelineScope[] = ['public', 'mine', 'managed', 'all'];
const statuses = ['draft', 'pending_review', 'published', 'cancelled', 'completed', 'archived'];
const publicStatuses = ['published', 'cancelled', 'completed'];
const phases = ['not_open', 'open', 'closed', 'unavailable'];
const day = 86_400_000;

type Query = Record<string, string>;

/** 契约：活动 ID 标准小写 UUID 字符串的 UTF-8 字节 FNV-1a 32 位无符号散列模 6。 */
export function colorIndex(id: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id.toLowerCase()))
    hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) % 6;
}

function window(q: Query) {
  const from = Date.parse(q.from ?? ''),
    to = Date.parse(q.to ?? '');
  if (!q.from || !q.to || !Number.isFinite(from) || !Number.isFinite(to))
    invalid('from', '起止时刻须成对填写');
  if (!(from < to)) invalid('to', '结束时刻必须晚于开始时刻');
  if (to - from > 31 * day) invalid('to', '日期窗口最长 31 天');
  return { from, to };
}

type Plan = { activity_id: string; start: number; end: number };

/** 本人已录取活动的计划时段，仅用于窗口内的重叠提示。取消活动不计重叠。 */
async function plannedSlots(db: Database, studentId: string, from: number, to: number) {
  const rows = await db.activity.findMany({
    where: {
      status: { in: ['published', 'completed'] },
      published_revision: { not: null },
      registrations: { some: { student_id: studentId, status: 'accepted' } },
    },
    include: { revisions: { where: { revision_state: 'approved' } } },
  });
  const plan: Plan[] = [];
  for (const row of rows) {
    const revision = row.revisions.find((r) => r.revision === row.published_revision);
    if (!revision) continue;
    for (const slot of slots((revision.content as unknown as ActivityInput).schedule)) {
      const start = Date.parse(slot.starts_at),
        end = Date.parse(slot.ends_at);
      if (start < to && end > from)
        plan.push({ activity_id: row.id, start, end });
    }
  }
  return plan;
}

function segmentsOf(view: Activity, from: number, to: number) {
  if (!view.schedule) return [];
  return slots(view.schedule)
    .map((slot) => ({ ...slot, start: Date.parse(slot.starts_at), end: Date.parse(slot.ends_at) }))
    .filter((slot) => slot.start < to && slot.end > from)
    .sort((a, b) => a.start - b.start);
}

function toActivity(
  view: Activity,
  now: Date,
  from: number,
  to: number,
  management: boolean,
  plan?: Plan[],
): TimelineActivity | null {
  const segments = segmentsOf(view, from, to);
  if (!segments.length || !view.schedule) return null;
  const others = plan?.filter((slot) => slot.activity_id !== view.id);
  const items: TimelineItem[] = segments.map((slot) => {
    const overlap = others?.some((o) => slot.start < o.end && slot.end > o.start);
    return {
      activity_id: view.id,
      activity_code: view.activity_code,
      title: view.title,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      status: view.status,
      occurrence_key: [view.id, view.schedule_revision, slot.starts_at].join('/'),
      schedule_revision: view.schedule_revision,
      schedule_type: view.schedule!.schedule_type,
      revision_state: view.revision_state,
      ...(view.registration_phase && { registration_phase: view.registration_phase }),
      ...(view.location && { location: view.location }),
      ...(overlap !== undefined && { has_planned_overlap: overlap }),
    };
  });
  return {
    activity_id: view.id,
    activity_code: view.activity_code,
    title: view.title,
    status: view.status,
    revision_state: view.revision_state,
    schedule_revision: view.schedule_revision,
    schedule_type: view.schedule.schedule_type,
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

export async function timelinePage(
  db: Database,
  actor: Actor,
  q: Query,
): Promise<TimelineActivityPage> {
  const scope = q.scope as TimelineScope;
  if (!scopes.includes(scope)) invalid('scope', '日程范围无效');
  const { from, to } = window(q);
  if (q.registration_phase && !phases.includes(q.registration_phase))
    invalid('registration_phase', '报名阶段筛选值无效');
  if (q.status && !statuses.includes(q.status)) invalid('status', '活动状态筛选值无效');
  if (q.revision_scope && !['published', 'working'].includes(q.revision_scope))
    invalid('revision_scope', '版本范围无效');
  if (q.owner_account_id && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.owner_account_id))
    invalid('owner_account_id', '负责人编号无效');

  const management = scope === 'managed' || scope === 'all';
  if (!management) {
    // 公开与本人范围固定读取获批版本，管理字段与筛选不对前台开放。
    if (q.revision_scope === 'working' || q.review_status || q.owner_account_id) denied();
    if (q.status && !publicStatuses.includes(q.status))
      invalid('status', '公开日程只能查看曾公开的活动');
  }
  const revision = management ? (q.revision_scope === 'published' ? 'published' : 'working') : 'published';
  const studentId = scope === 'mine' ? actor.student?.id : undefined;

  let where: Prisma.ActivityWhereInput;
  if (scope === 'public')
    where = { published_revision: { not: null }, status: q.status ?? 'published' };
  else if (scope === 'mine')
    where = {
      published_revision: { not: null },
      registrations: {
        some: { student_id: studentId ?? { in: [] }, status: 'accepted' },
      },
      ...(q.status && { status: q.status }),
    };
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

  const views = await activityViews(db, where, management ? revision : 'public', q, studentId);
  const plan =
    scope === 'mine' && studentId
      ? await plannedSlots(db, studentId, from, to)
      : undefined;
  const items = views.items
    .map((view) => toActivity(view, views.now, from, to, management, plan))
    .filter((item): item is TimelineActivity => item !== null);
  return {
    items,
    total: views.total,
    page: views.page,
    page_size: views.page_size,
    state_evaluated_at: views.now.toISOString(),
  };
}
