import type { NotificationEvent, Receipt, Notice } from '@hongyan/contracts/types';
import type {
  Notice as NoticeRow,
  NoticeReceipt,
  NotificationEvent as EventRow,
} from '../generated/prisma/client.js';

// 变更字段对学生的可读名称。嵌套字段只取根键，避免把技术路径暴露给用户。
const changeFieldLabels: Record<string, string> = {
  location: '活动地点',
  meeting_point: '集合地点',
  campus: '校区',
  schedule: '活动时间',
  registration_opens_at: '报名开始时间',
  registration_closes_at: '报名截止时间',
  result_expected_at: '结果公布时间',
  transport_notes: '交通说明',
  capacity: '名额',
  eligibility_text: '报名条件',
  selection_text: '录取说明',
  group_join_instructions: '入群方式',
  hours_rule_text: '时长规则',
  expected_hours: '预计时长',
  expected_hours_basis: '时长计算依据',
  hours_import_expected_at: '时长导入时间',
};

const stamp = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function clip(text: string, limit = 30): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function moment(value: unknown): string {
  const at = typeof value === 'string' ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? stamp.format(at) : '未设置';
}

const scheduleKinds: Record<string, string> = {
  continuous: '单次',
  weekly: '每周',
  custom: '多时段',
};

type ScheduleLike = { starts_at?: unknown; ends_at?: unknown; schedule_type?: unknown };

function isSchedule(value: object): value is ScheduleLike {
  return 'starts_at' in value || 'ends_at' in value || 'schedule_type' in value;
}

// 活动时间可能只填截止时间，也可能按周重复，逐种情况给出一句能读懂的描述。
function scheduleText(schedule: ScheduleLike): string {
  const from = schedule.starts_at ? moment(schedule.starts_at) : '';
  const to = schedule.ends_at ? moment(schedule.ends_at) : '';
  const range = from && to ? `${from} 至 ${to}` : to ? `截止 ${to}` : from ? `${from} 起` : '未设置';
  const kind = scheduleKinds[String(schedule.schedule_type)];
  return kind ? `${range}（${kind}）` : range;
}

// 把快照里的字段值变成学生能直接读懂的一句话，时间统一按东八区展示。
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未设置';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return clip(value.map(String).join('、'));
  if (typeof value === 'object' && isSchedule(value)) return scheduleText(value);
  return clip(JSON.stringify(value));
}

function read(source: unknown, key: string): unknown {
  return source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
}

// 变更说明只讲"哪里从什么变成了什么"，比罗列字段名更能帮学生判断要不要重新看安排。
function changeLines(fields: string[], before: unknown, after: unknown): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const field of fields) {
    const root = field.split('.')[0];
    if (seen.has(root)) continue;
    seen.add(root);
    const label = changeFieldLabels[root] ?? '活动信息';
    lines.push(`${label}：${displayValue(read(before, root))} → ${displayValue(read(after, root))}`);
  }
  return lines;
}

export function changeNoticeBody(fields: string[], before: unknown, after: unknown): string {
  const lines = changeLines(fields, before, after);
  const detail = lines.length ? lines.map((line) => `· ${line}`).join('\n') : '· 活动信息已更新';
  return `以下内容有调整：\n${detail}\n请查看最新安排，并在活动详情页确认。`;
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
    resource_id: row.resource_id ?? '',
    status: row.status as NotificationEvent['status'],
    attempt_count: row.attempt_count,
    ...(row.last_error ? { last_error: row.last_error } : {}),
    ...(row.next_retry_at ? { next_retry_at: row.next_retry_at.toISOString() } : {}),
    created_at: row.created_at.toISOString(),
  };
}
