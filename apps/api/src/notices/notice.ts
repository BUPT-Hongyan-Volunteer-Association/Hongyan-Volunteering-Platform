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

export function changedLabels(fields: string[]): string[] {
  return [
    ...new Set(fields.map((field) => changeFieldLabels[field.split('.')[0]] ?? '活动信息')),
  ];
}

export function changeNoticeBody(title: string, fields: string[]): string {
  const labels = changedLabels(fields);
  const detail = labels.length ? labels.join('、') : '活动信息';
  return `${title}有以下内容调整：${detail}。请查看最新安排并在活动详情页确认。`;
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
