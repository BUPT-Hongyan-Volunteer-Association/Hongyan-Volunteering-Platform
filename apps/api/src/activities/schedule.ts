import type { ActivitySchedule, ScheduleSlot } from '@hongyan/contracts/types';
import { invalid } from '../http.js';

const day = 86_400_000;

export function parseCalendarDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + 'T') ? date : null;
}

export function serviceDayMilliseconds(times: readonly ScheduleSlot[], serviceDate: string) {
  const start = Date.parse(serviceDate + 'T00:00:00+08:00');
  const end = start + day;
  return times.reduce((total, slot) => {
    const from = Math.max(start, Date.parse(slot.starts_at));
    const until = Math.min(end, Date.parse(slot.ends_at));
    return total + Math.max(0, until - from);
  }, 0);
}

export function* occurrences(
  schedule: ActivitySchedule,
): Generator<{ slot: ScheduleSlot; field: string }> {
  if (schedule.schedule_type === 'date_range') {
    const { duration_start_date: start, duration_end_date: end } = schedule;
    if (start && end)
      yield {
        field: 'schedule',
        slot: {
          starts_at: start + 'T00:00:00+08:00',
          ends_at: new Date(Date.parse(end + 'T00:00:00+08:00') + day).toISOString(),
        },
      };
    return;
  }
  if (schedule.schedule_type === 'continuous') {
    yield { slot: schedule, field: 'schedule' };
    return;
  }
  if (schedule.schedule_type === 'custom') {
    for (const [i, slot] of schedule.slots.entries()) yield { slot, field: 'schedule.slots.' + i };
    return;
  }
  for (const [i, slot] of (schedule.additional_slots ?? []).entries())
    yield { slot, field: 'schedule.additional_slots.' + i };
  const lastDay = Date.parse(schedule.duration_end_date);
  const excluded = new Set(schedule.excluded_dates);
  for (let t = Date.parse(schedule.duration_start_date); t <= lastDay; t += day) {
    const date = new Date(t);
    const localDay = date.toISOString().slice(0, 10);
    if (excluded.has(localDay)) continue;
    for (const [i, rule] of schedule.weekly_slots.entries()) {
      if (rule.weekday !== (date.getUTCDay() || 7)) continue;
      const endDay = new Date(t + rule.end_day_offset * day).toISOString().slice(0, 10);
      yield {
        field: 'schedule.weekly_slots.' + i,
        slot: {
          starts_at: localDay + 'T' + rule.start_time + '+08:00',
          ends_at: endDay + 'T' + rule.end_time + '+08:00',
        },
      };
    }
  }
}

export function slots(schedule?: ActivitySchedule) {
  if (!schedule) return [];
  return Array.from(occurrences(schedule), ({ slot }) => slot);
}

export function validateSchedule(schedule: ActivitySchedule) {
  let from = -Infinity,
    until = Infinity;
  if (schedule.schedule_type !== 'continuous') {
    from = Date.parse(schedule.duration_start_date + 'T00:00:00+08:00');
    until = Date.parse(schedule.duration_end_date + 'T00:00:00+08:00') + day;
    if (until <= from) invalid('schedule.duration_end_date', '结束日期不能早于开始日期');
  }
  const segments = [];
  for (const { slot, field } of occurrences(schedule)) {
    const start = Date.parse(slot.starts_at),
      end = Date.parse(slot.ends_at);
    if (!(start < end)) invalid(field, '时段开始必须早于结束');
    if (start < from || end > until) invalid(field, '完整时段须落在活动持续日期内（北京时间）');
    segments.push({ start, end, field });
  }
  if (!segments.length) invalid('schedule', '至少需要一个有效时段');
  segments.sort((a, b) => a.start - b.start);
  for (let i = 1; i < segments.length; i++)
    if (segments[i].start < segments[i - 1].end) invalid(segments[i].field, '服务时段不能重叠');
  return segments[0].start;
}

export function cachedSlots(): typeof slots {
  const bySchedule = new WeakMap<ActivitySchedule, ScheduleSlot[]>();
  return schedule => {
    if (!schedule) return [];
    let values = bySchedule.get(schedule);
    if (!values) {
      values = slots(schedule);
      bySchedule.set(schedule, values);
    }
    return values;
  };
}
