import {
  listActivities,
  listManagedActivities,
  type Activity,
  type TimelineActivity,
  type TimelineActivityPage,
} from '@hongyan/contracts';

export type Scope = 'public' | 'mine' | 'managed' | 'all';
export const evaluatedAt = '2026-11-18T10:00:00+08:00';
export const palette = ['#3B82F6', '#10B981', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16'];
export { statusLabels, phaseLabels } from '../activityDisplay';
export const standalone = '72000000-0000-4000-8000-000000000015';
const multi = [
  ['2026-11-18T09:15:00+08:00', '2026-11-18T11:30:00+08:00'],
  ['2026-11-21T09:30:00+08:00', '2026-11-21T10:45:00+08:00'],
  ['2026-11-21T14:15:00+08:00', '2026-11-21T15:45:00+08:00'],
];
const single = [['2026-11-21T13:00:00+08:00', '2026-11-21T15:15:00+08:00']];
function colorIndex(id: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id.toLowerCase()))
    hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) % palette.length;
}
function sample(a?: Activity): TimelineActivity {
  const id = a?.id ?? standalone;
  const code = a?.activity_code ?? 'PX-0003';
  const multiple = code === 'P2026-0001';
  const schedule = multiple ? multi : single;
  const status = a?.status ?? 'published';
  const fields = {
    activity_id: id,
    activity_code: code,
    title: a?.title ?? '社区资料整理',
    status,
    registration_phase: (status === 'published'
      ? multiple
        ? 'closed'
        : 'open'
      : 'unavailable') as TimelineActivity['registration_phase'],
    campus: a?.campus,
    location: a?.location || '社区服务中心',
    schedule_revision: a?.schedule_revision ?? 1,
    revision_state: a?.revision_state ?? 'approved',
    schedule_type: multiple ? ('custom' as const) : ('continuous' as const),
  };
  const now = Date.parse(evaluatedAt);
  return {
    ...fields,
    capacity: a?.capacity ?? 12,
    owner_display_name: a?.owner_display_name ?? '示例负责人',
    color_index: colorIndex(id),
    state_evaluated_at: evaluatedAt,
    is_ongoing:
      status === 'published' &&
      schedule.some(([from, to]) => Date.parse(from) <= now && now < Date.parse(to)),
    ...(a?.has_pending_review !== undefined && {
      has_pending_review: a.has_pending_review,
      current_review_id: a.current_review_id,
    }),
    segments: schedule.map(([starts_at, ends_at]) => ({
      ...fields,
      starts_at,
      ends_at,
      occurrence_key: [id, fields.schedule_revision, starts_at].join('/'),
    })),
  };
}
/** 仅为两项种子活动生成示例时段。现有列表服务负责角色、成员及获批版本的可见性。 */
export async function examplePage(
  scope: Scope,
  revision: 'working' | 'published',
): Promise<TimelineActivityPage> {
  const items: TimelineActivity[] = [];
  for (const code of ['P2026-0001', 'P2026-0002']) {
    const response =
      scope === 'managed' || scope === 'all'
        ? await listManagedActivities({
            query: { scope, revision_scope: revision, q: code },
            throwOnError: true,
          })
        : await listActivities({ query: { scope, q: code }, throwOnError: true });
    const match = response.data.data.items.find((a) => a.activity_code === code);
    if (match) items.push(sample(match));
  }
  if (scope === 'public' || scope === 'all') items.push(sample());
  return { items, total: items.length, page: 1, page_size: 20, state_evaluated_at: evaluatedAt };
}
export { localDate as beijingDate } from '../activityDisplay';
export const localTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
