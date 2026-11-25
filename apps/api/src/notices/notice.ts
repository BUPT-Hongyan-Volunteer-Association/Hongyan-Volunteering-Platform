import type {
  ActivityInput,
  NotificationEvent,
  Receipt,
  Notice,
} from '@hongyan/contracts/types';
import type {
  Notice as NoticeRow,
  NoticeReceipt,
  NotificationEvent as EventRow,
} from '../generated/prisma/client.js';
import { stable } from '../database.js';
import { serviceDateText } from '@hongyan/contracts/activity';

const fieldLabels = {
  schedule: '活动时间',
  registration_opens_at: '报名开始时间',
  registration_closes_at: '报名截止时间',
  contacts: '联系方式',
  campus: '校区',
  location: '活动地点',
  meeting_point: '集合地点',
  transport_notes: '交通说明',
  capacity: '名额',
  eligibility_text: '报名条件',
  selection_text: '录取说明',
  group_qr_id: '入群方式',
  hours_import_date: '预计时长导入日期',
  group_join_instructions: '入群方式',
  hours_rule_text: '时长规则',
  expected_hours: '预计时长',
  expected_hours_basis: '时长计算依据',
} satisfies Partial<Record<keyof ActivityInput, string>>;
type Field = keyof typeof fieldLabels;
export const notifiedFields = new Set<string>(Object.keys(fieldLabels));

const stamp = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const moment = (iso: string) => stamp.format(new Date(iso));
function display(field: Field, version: ActivityInput) {
  const value = version[field];
  if (value == null || value === '') return '未设置';
  if (field === 'schedule') return serviceDateText(version.schedule);
  if (field === 'contacts') return version.contacts?.join('、') || '未设置';
  if (field.endsWith('_at') && typeof value === 'string') return moment(value);
  return String(value);
}

// 累积尚待确认的变更。字段改回原值时仍展示最近的不同值，学生能看清这次恢复了什么。
export function changeNoticeBody(versions: ActivityInput[]) {
  const latest = versions[versions.length - 1];
  const newestFirst = versions.slice().reverse();
  const lines: string[] = [];
  for (const field of Object.keys(fieldLabels) as Field[]) {
    const finalValue = stable(latest[field]);
    const different = (version: ActivityInput) => stable(version[field]) !== finalValue;
    const before = different(versions[0]) ? versions[0] : newestFirst.find(different);
    if (!before) continue;
    const label = fieldLabels[field];
    if (field === 'group_join_instructions' || field === 'group_qr_id') {
      lines.push(`· ${label}：已更新，录取后可进入活动详情查看`);
    } else {
      const from = display(field, before),
        to = display(field, latest);
      lines.push(`· ${label}：${from === to ? '已更新，请查看最新安排' : `${from} → ${to}`}`);
    }
  }
  return `以下内容有调整：\n${[...new Set(lines)].join('\n')}\n请核对最新安排并确认收到`;
}

export function noticeView(row: NoticeRow, receipt?: NoticeReceipt | null): Notice {
  return {
    id: row.id,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    activity_id: row.activity_id,
    title: row.title,
    body: row.body,
    requires_ack: row.requires_ack,
    published_at: row.published_at.toISOString(),
    notice_kind: row.notice_kind as Notice['notice_kind'],
    information_version: row.information_version,
    is_current: row.is_current,
    ...(receipt?.follow_up_closed && { follow_up_closed: true }),
    ...(row.supersedes_id ? { supersedes_id: row.supersedes_id } : {}),
    ...(row.source_notice_id ? { source_notice_id: row.source_notice_id } : {}),
    ...(row.published_by ? { published_by: row.published_by } : {}),
    ...(receipt?.read_at ? { read_at: receipt.read_at.toISOString() } : {}),
    ...(receipt?.acknowledged_at ? { acknowledged_at: receipt.acknowledged_at.toISOString() } : {}),
  };
}

type ReceiptRow = NoticeReceipt & {
  student: { student_no: string; account: { display_name: string } };
};

export function receiptView(row: ReceiptRow): Receipt {
  const acknowledged_at = row.acknowledged_at?.toISOString();
  return {
    notice_id: row.notice_id,
    student_id: row.student_id,
    student_no: row.student.student_no,
    student_name: row.student.account.display_name,
    ...(row.read_at ? { read_at: row.read_at.toISOString() } : {}),
    ...(acknowledged_at ? { acknowledged_at } : {}),
    status: acknowledged_at ? 'acknowledged' : row.read_at ? 'read' : 'unread',
  };
}

export function eventView(row: EventRow): NotificationEvent {
  return {
    id: row.id,
    version: row.version,
    event_type: row.event_type,
    ...(row.activity_id ? { activity_id: row.activity_id } : {}),
    resource_id: row.resource_id,
    status: row.status as NotificationEvent['status'],
    attempt_count: row.attempt_count,
    ...(row.last_error ? { last_error: row.last_error } : {}),
    ...(row.next_retry_at ? { next_retry_at: row.next_retry_at.toISOString() } : {}),
    created_at: row.created_at.toISOString(),
  };
}
