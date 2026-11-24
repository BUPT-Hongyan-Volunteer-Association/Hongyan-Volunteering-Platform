import { activeRegistrationStatuses } from '@hongyan/contracts/activity';
import type { Prisma } from '../generated/prisma/client.js';
import { invalid } from '../http.js';

export const receiptStatuses = ['unread', 'read', 'acknowledged'] as const;
export type ReceiptStatus = (typeof receiptStatuses)[number];
export interface ReceiptFilters {
  status?: ReceiptStatus;
  follow_up_only: boolean;
}
export const attendanceKinds = ['change', 'gathering'];

export function receiptStatus(value: string | undefined): ReceiptStatus | undefined {
  if (value !== undefined && !receiptStatuses.includes(value as ReceiptStatus))
    invalid('status', '回执状态无效');
  return value as ReceiptStatus | undefined;
}

/** 回执列表与导出共用的筛选；follow_up_only 范围内已读未确认仍需保留。 */
export function receiptWhere(
  notice: { id: string; activity_id: string; notice_kind: string },
  filters: ReceiptFilters,
): Prisma.NoticeReceiptWhereInput {
  const { status, follow_up_only } = filters;
  return {
    notice_id: notice.id,
    ...(status === 'unread' && { read_at: null }),
    ...(status === 'read' && { read_at: { not: null }, acknowledged_at: null }),
    ...(status === 'acknowledged' && { acknowledged_at: { not: null } }),
    ...(follow_up_only && { acknowledged_at: null, follow_up_closed: false }),
    ...(follow_up_only &&
      attendanceKinds.includes(notice.notice_kind) && {
        student: {
          registrations: {
            some: { activity_id: notice.activity_id, status: { in: activeRegistrationStatuses } },
          },
        },
      }),
  };
}

/** 当前通知已不需要确认时，待跟进范围为空。 */
export function followUpEmpty(
  notice: { is_current: boolean; requires_ack: boolean },
  filters: ReceiptFilters,
) {
  return filters.follow_up_only && (!notice.is_current || !notice.requires_ack || filters.status === 'acknowledged');
}