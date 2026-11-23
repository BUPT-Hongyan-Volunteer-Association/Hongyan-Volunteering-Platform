import { campuses, campusName } from '@hongyan/contracts/activity';
import type { TimelineActivityPage } from '@hongyan/contracts';
import { statusLabels } from '../activityDisplay';
import type { TimeUnit } from './window';

export const revisionOptions: readonly { value: 'working' | 'published'; label: string }[] = [
  { value: 'working', label: '工作版本' },
  { value: 'published', label: '获批版本' },
];

export function unitArrows(unit: TimeUnit): [string, string] {
  if (unit === 'week') return ['上一周', '下一周'];
  if (unit === 'month') return ['上个月', '下个月'];
  return ['前一天', '后一天'];
}

export function statusOptionsFor(managed: boolean): { value: string; label: string }[] {
  return [
    { value: '', label: '所有状态' },
    ...Object.entries(statusLabels)
      .filter(([key]) => managed || ['published', 'cancelled', 'completed'].includes(key))
      .map(([value, label]) => ({ value, label })),
  ];
}

export function campusOptionsFor(selected: string): { value: string; label: string }[] {
  const options = campuses.map((campus) => ({ value: campus, label: campus }));
  // 保留筛选值：历史链接可能带旧简称，仍能显示并区分。
  if (selected && !options.some((option) => option.value === selected))
    options.unshift({ value: selected, label: campusName(selected) });
  return [{ value: '', label: '所有校区' }, ...options];
}

export function ownerOptionsFor(
  lastPage: TimelineActivityPage | undefined,
  selected: string,
): { value: string; label: string }[] {
  const options = (lastPage?.owner_options ?? []).map((owner) => ({
    value: owner.account_id,
    label: owner.display_name,
  }));
  // 服务端候选按授权范围独立取得，不随当前页或筛选收缩；已选值缺失时也保留。
  if (selected && !options.some((option) => option.value === selected))
    options.push({ value: selected, label: '所选负责人' });
  return [{ value: '', label: '所有负责人' }, ...options];
}
