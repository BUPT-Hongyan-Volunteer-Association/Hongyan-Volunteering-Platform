import type { Activity } from './generated/types.gen.js';

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

export const localDate = (value: string | number) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function activityContacts(
  activity?: Pick<Activity, 'contacts' | 'phone' | 'wechat'>,
): string[] {
  return (
    activity?.contacts ??
    [activity?.phone, activity?.wechat].filter((value): value is string => !!value)
  );
}
export function resultDate(
  activity?: Pick<Activity, 'result_expected_date' | 'result_expected_at'>,
) {
  return (
    activity?.result_expected_date ??
    (activity?.result_expected_at && localDate(activity.result_expected_at))
  );
}
