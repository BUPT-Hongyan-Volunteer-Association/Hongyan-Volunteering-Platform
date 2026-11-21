import { activityTypes, localDate, localDateTime } from './activityDisplay';
import type { IconName } from './UiIcon.vue';

type Field = [
  key: string,
  label: string,
  control?: 'number' | 'datetime-local' | 'select' | 'textarea' | 'date' | 'campus' | 'qr' | 'contacts',
];
export const fieldGroups: { title: string; icon: IconName; fields: Field[] }[] = [
  {
    title: '服务信息',
    icon: 'Document',
    fields: [
      ['title', '活动标题'],
      ['beneficiaries', '服务对象'],
      ['description', '服务内容', 'textarea'],
      ['campus', '校区', 'campus'],
      ['location', '活动地点'],
      ['meeting_point', '集合地点'],
      ['transport_notes', '交通说明'],
    ],
  },
  {
    title: '服务与报名时间',
    icon: 'Calendar',
    fields: [
      ['duration_start_date', '活动开始日期', 'date'],
      ['duration_end_date', '活动结束日期', 'date'],
      ['registration_opens_at', '报名开放', 'datetime-local'],
      ['registration_closes_at', '报名截止', 'datetime-local'],
      ['result_expected_date', '预计结果公布日期', 'date'],
    ],
  },
  {
    title: '参与与录取',
    icon: 'User',
    fields: [
      ['capacity', '计划名额', 'number'],
      ['eligibility_text', '报名条件'],
      ['group_join_instructions', '入群方式'],
      ['group_qr_id', '群二维码', 'qr'],
      ['contacts', '联系方式', 'contacts'],
      ['safety_notes', '安全或培训说明'],
    ],
  },
  {
    title: '时长认定',
    icon: 'Clock',
    fields: [
      ['expected_hours', '预计时长'],
      ['expected_hours_basis', '预计时长口径', 'select'],
      ['hours_rule_text', '时长认定说明'],
      ['hours_import_date', '预计时长导入日期', 'date'],
    ],
  },
];
export const activityFields = fieldGroups.flatMap((g) => g.fields);
const labels: Record<string, string> = {
  ...Object.fromEntries(activityFields.map(([key, label]) => [key, label])),
  phone: '手机号', wechat: '微信号', result_expected_at: '预计结果公布日期',
  selection_text: '录取说明', contact_text: '原联系渠道', starts_at: '开始时间', ends_at: '结束时间', hours_import_expected_at: '预计时长导入时间',
  schedule: '活动安排',
  schedule_type: '时间类型',
  duration_start_date: '周期开始',
  duration_end_date: '周期结束',
  weekly_slots: '每周时段',
  excluded_dates: '暂停日期',
  additional_slots: '补充时段',
  slots: '服务时段',
  weekday: '星期',
  start_time: '开始时间',
  end_time: '结束时间',
  end_day_offset: '结束日期',
};
export const fieldLabel = (path: string) =>
  path
    .split('.')
    .map((key) => labels[key] ?? key)
    .join(' / ');

export function fieldValue(key: string, value: unknown): string {
  if (value == null || value === '') return '未填写';
  if (Array.isArray(value))
    return value.length ? value.map((v) => fieldValue(key, v)).join('\n') : '无';
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([k, v]) => fieldLabel(k) + '　' + fieldValue(k, v))
      .join('\n');
  const part = key.split('.').at(-1) || key;
  if (part === 'result_expected_at' && typeof value === 'string') return localDate(value);
  if (part.endsWith('_at') && typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return localDateTime(value) + '（北京时间）';
  if (part === 'schedule_type' && Object.hasOwn(activityTypes, String(value)))
    return activityTypes[value as keyof typeof activityTypes];
  if (part === 'expected_hours_basis') return value === 'whole_activity' ? '整期' : '单次';
  if (part === 'expected_hours') return value + ' 小时';
  if (part === 'group_qr_id') return '已上传二维码';
  if (part === 'capacity') return value + ' 人';
  if (part === 'weekday') return '周' + '一二三四五六日'[Number(value) - 1];
  if (part === 'end_day_offset') return value ? '次日' : '当日';
  return String(value);
}
