import type { Activity, TimelineActivity } from '@hongyan/contracts';
import { timelineColors } from '../activityDisplay';

export const evaluatedAt = '2026-11-18T10:00:00+08:00';
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
  return (hash >>> 0) % timelineColors.length;
}
export function sampleActivity(a?: Activity): TimelineActivity {
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
