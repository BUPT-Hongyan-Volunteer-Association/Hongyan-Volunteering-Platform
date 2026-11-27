import type { Activity, ActivityInput, RegistrationItem, ActivitySchedule, DateRangeSchedule, Registration, RegistrationDecision } from './generated/types.gen.js';

export function isUnpublishedDraft(activity: Pick<Activity, 'status' | 'published_revision'>) {
  return activity.published_revision == null && activity.status === 'draft';
}

export const activeRegistrationStatuses: Registration['status'][] = ['submitted', 'waitlisted', 'accepted'];

export function canChangeRegistration(status: string, decision: RegistrationDecision['decision']) {
  return ['submitted', 'waitlisted', 'rejected'].includes(status) && status !== decision;
}

export function selectionRestriction(
  config: Pick<ActivityInput, 'allow_multiple_roles' | 'allow_multiple_slots'>,
  items: readonly RegistrationItem[],
) {
  if (items.length < 2) return '';
  if (!config.allow_multiple_roles && !config.allow_multiple_slots) return '本活动限报一个报名项';
  const roles = new Set(items.flatMap(item => item.role ? [item.role.trim()] : []));
  if (!config.allow_multiple_roles && roles.size > 1) return '本活动限报一个岗位';
  const slots = new Set(items.flatMap(item => item.starts_at && item.ends_at
    ? [Date.parse(item.starts_at) + '/' + Date.parse(item.ends_at)] : []));
  return !config.allow_multiple_slots && slots.size > 1 ? '本活动限报一个时段' : '';
}

export const campuses = ['沙河校区', '西土城校区', '沙河及西土城校区'];
export function campusName(value?: string) {
  if (value === '沙河') return campuses[0];
  if (['海淀', '海淀校区', '西土城'].includes(value ?? '')) return campuses[1];
  if (value === '两个校区') return campuses[2];
  return value ?? '';
}
export function matchesCampus(value: string | undefined, filter: string) {
  const name = campusName(value),
    selected = campusName(filter);
  return (
    name === selected ||
    (name === campuses[2] && (selected === campuses[0] || selected === campuses[1]))
  );
}

export const localDate = (value: string | number | Date) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);

type ServiceDates = Pick<DateRangeSchedule, 'duration_start_date' | 'duration_end_date'>;

export function serviceDates(schedule?: ActivitySchedule | ServiceDates): ServiceDates {
  if (!schedule) return {};
  if ('starts_at' in schedule) {
    return {
      duration_start_date: localDate(schedule.starts_at),
      duration_end_date: localDate(Date.parse(schedule.ends_at) - 1),
    };
  }
  return { duration_start_date: schedule.duration_start_date, duration_end_date: schedule.duration_end_date };
}

export function serviceDateText(schedule?: ActivitySchedule | ServiceDates) {
  const { duration_start_date: first, duration_end_date: last } = serviceDates(schedule);
  if (!first || !last) return '日期待定';
  return first === last ? first : first + ' 至 ' + last;
}

export function serviceWindow(schedule?: ActivitySchedule | ServiceDates) {
  const { duration_start_date: first, duration_end_date: last } = serviceDates(schedule);
  if (!first || !last) return undefined;
  return { start: Date.parse(first + 'T00:00:00+08:00'), end: Date.parse(last + 'T00:00:00+08:00') + 86400000 };
}

/** 整项活动的办理边界，日期范围包括结束日全天。 */
export function activityBounds(schedule?: ActivitySchedule) {
  if (schedule?.schedule_type === 'continuous')
    return { start: Date.parse(schedule.starts_at), end: Date.parse(schedule.ends_at) };
  return serviceWindow(schedule);
}
