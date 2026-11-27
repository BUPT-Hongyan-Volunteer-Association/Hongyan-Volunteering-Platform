import { registrationItemLabel } from '@hongyan/contracts/activity';
import type { RegistrationItem } from '@hongyan/contracts';
import { localDateTime } from './activityDisplay';
import type { IconName } from './UiIcon.vue';

type Field = [
  key: string,
  label: string,
  control?: 'number' | 'datetime-local' | 'textarea' | 'date' | 'campus' | 'qr' | 'contacts',
];
export const fieldGroups: { title: string; icon: IconName; fields: Field[] }[] = [
  {
    title: '活动信息',
    icon: 'Document',
    fields: [
      ['title', '活动标题'],
      ['beneficiaries', '服务对象'],
      ['description', '服务内容', 'textarea'],
      ['campus', '校区', 'campus'],
      ['location', '活动地点'],
      ['meeting_point', '集合地点'],
      ['transport_notes', '交通说明'],
      ['precautions', '注意事项', 'textarea'],
      ['related_notes', '相关说明', 'textarea'],
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
    ],
  },
  {
    title: '参与与录取',
    icon: 'User',
    fields: [
      ['capacity', '计划名额', 'number'],
      ['waitlist_capacity', '候补人数', 'number'],
      ['group_join_instructions', '入群方式'],
      ['group_qr_id', '群二维码', 'qr'],
      ['contacts', '联系方式', 'contacts'],
      ['safety_notes', '安全或培训说明', 'textarea'],
    ],
  },
  {
    title: '时长认定',
    icon: 'Clock',
    fields: [
      ['hours_rule_text', '时长认定说明'],
      ['hours_import_date', '预计时长导入日期', 'date'],
    ],
  },
];
export const activityFields = fieldGroups.flatMap((g) => g.fields);
const labels: Record<string, string> = {
  ...Object.fromEntries(activityFields.map(([key, label]) => [key, label])),
  registration_mode: '报名方式', registration_items: '报名项', role: '岗位',
  allow_multiple_roles: '允许多岗', allow_multiple_slots: '允许多时段',
  questions: '报名问卷', type: '题型', required: '必答', options: '选项', label: '选项内容',
  starts_at: '开始时间', ends_at: '结束时间',
  schedule: '活动日期',
  duration_start_date: '活动开始日期',
  duration_end_date: '活动结束日期',
  weekly_slots: '每周时段',
  excluded_dates: '暂停日期',
  additional_slots: '补充时段',
  slots: '服务时段',
  weekday: '星期',
  start_time: '开始时间',
  end_time: '结束时间',
  end_day_offset: '结束日期',
};
const questionLabels: Record<string, string> = { title: '题目', description: '题目说明' };
export function fieldLabel(path: string) {
  const parts = path.split('.');
  return parts.map((key, index) => {
    if (/^\d+$/.test(key)) {
      const unit = parts[index - 1] === 'questions' ? '题' : '项';
      return '第 ' + (Number(key) + 1) + ' ' + unit;
    }
    if (parts[0] === 'questions' && index === 2 && questionLabels[key]) return questionLabels[key];
    return labels[key] ?? key;
  }).join(' / ');
}

export function fieldValue(key: string, value: unknown): string {
  if (value == null || value === '') return '未填写';
  if (Array.isArray(value))
    return value.length ? value.map((v) => fieldValue(key, v)).join('\n') : '无';
  if (key === 'registration_items' && typeof value === 'object' && 'starts_at' in value && 'ends_at' in value) {
    const item = value as RegistrationItem;
    return [registrationItemLabel(item), '录取 ' + item.capacity + ' 人', '候补 ' + item.waitlist_capacity + ' 人'].join(' · ');
  }
  if (typeof value === 'object')
    return Object.entries(value)
      .filter(([key]) => key !== 'schedule_type' && key !== 'id')
      .map(([k, v]) => ((key === 'questions' && questionLabels[k]) || fieldLabel(k)) + '　' + fieldValue(k, v))
      .join('\n');
  const part = key.split('.').at(-1) || key;
  if (part.endsWith('_at') && typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return localDateTime(value) + '（北京时间）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (part === 'registration_mode') return value === 'batch' ? '分批报名' : '整批报名';
  if (part === 'type') return ({ single: '单选题', multiple: '多选题', text: '填空题' } as Record<string,string>)[String(value)] ?? String(value);
  if (part === 'group_qr_id') return '已上传二维码';
  if (part === 'capacity' || part === 'waitlist_capacity') return value + ' 人';
  if (part === 'weekday') return '周' + '一二三四五六日'[Number(value) - 1];
  if (part === 'end_day_offset') return value ? '次日' : '当日';
  return String(value);
}
