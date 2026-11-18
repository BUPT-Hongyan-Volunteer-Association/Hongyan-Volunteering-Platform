import type { Activity } from '@hongyan/contracts';

export const activityTypes = { continuous: '单次活动', weekly: '每周活动', custom: '多时段活动' };
export const statusLabels = {
  draft: '草稿',
  pending_review: '待审核',
  published: '已发布',
  cancelled: '已取消',
  completed: '已结束',
  archived: '已归档',
};
export const phaseLabels = {
  not_open: '未开放',
  open: '报名中',
  closed: '已截止',
  unavailable: '不适用',
};
export const phaseOptions = [
  { value: '', label: '所有阶段' },
  ...Object.entries(phaseLabels).map(([value, label]) => ({ value, label })),
];
export const reviewLabels = {
  pending: '待审核',
  approved: '已批准',
  rejected: '已驳回',
  withdrawn: '已撤回',
  cancelled: '已取消',
};
export const revisionLabels = {
  draft: '草稿',
  pending_review: '待审核',
  approved: '已批准',
  rejected: '已驳回',
  withdrawn: '已撤回',
  cancelled: '已取消',
};

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', ...options });
const dateClock = format({
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const clock = format({ hour: '2-digit', minute: '2-digit' });
export const localDate = (value: string | number) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const localDateTime = (iso: string) => dateClock.format(new Date(iso));
export function serviceTime(row: Activity) {
  const s = row.schedule;
  if (s.schedule_type === 'weekly' && s.weekly_slots.length === 1) {
    const slot = s.weekly_slots[0];
    return (
      '每周' +
      '一二三四五六日'[slot.weekday - 1] +
      ' ' +
      slot.start_time.slice(0, 5) +
      '–' +
      (slot.end_day_offset ? '次日 ' : '') +
      slot.end_time.slice(0, 5)
    );
  }
  if (s.schedule_type !== 'continuous')
    return localDate(row.starts_at) + ' 至 ' + localDate(row.ends_at);
  if (localDate(row.starts_at) === localDate(row.ends_at))
    return localDateTime(row.starts_at) + '–' + clock.format(new Date(row.ends_at));
  return localDateTime(row.starts_at) + ' 至 ' + localDateTime(row.ends_at);
}
