export { localDate } from '@hongyan/contracts/activity';

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
export function activityPrimaryStatus(activity: {
  status: keyof typeof statusLabels;
  is_ongoing?: boolean;
  registration_phase?: keyof typeof phaseLabels;
}) {
  if (activity.status !== 'published') return statusLabels[activity.status];
  if (activity.is_ongoing) return '进行中';
  return activity.registration_phase ? phaseLabels[activity.registration_phase] : statusLabels.published;
}

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

export function beijingInput(iso: unknown) {
  if (typeof iso !== 'string' || !iso) return '';
  const instant = Date.parse(iso);
  return Number.isFinite(instant) ? new Date(instant + 8 * 3600_000).toISOString().slice(0, 16) : '';
}

export function beijingISO(value: string) {
  return new Date(value + '+08:00').toISOString();
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', ...options });
const dateClock = format({
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
export const timelineColors = ['#3B82F6', '#10B981', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16'];
export const localDateTime = (iso: string) => dateClock.format(new Date(iso));
