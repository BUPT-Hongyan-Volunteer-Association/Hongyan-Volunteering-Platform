import type { HourRecord as HourView } from '@hongyan/contracts/types';
import { Prisma, type HourRecord } from '../generated/prisma/client.js';
import { type Actor, studentId } from '../auth/session.guard.js';
import { managedScope, pagination, staff } from '../activities/read.js';
import { parseCalendarDate } from '../activities/schedule.js';
import type { Tx } from '../database.js';
import { denied, invalid, invisible } from '../http.js';
import { dateText } from './ledger-data.js';

export type HourLedgerScope =
  | { type: 'my_hours' }
  | { type: 'activity_hours'; activity_id: string }
  | { type: 'admin_student_hours'; student_id: string };

export interface HourLedgerFilters {
  from_date?: string;
  to_date?: string;
  include_history?: boolean;
}

export function hourLedgerFilters(query: Record<string, string>): HourLedgerFilters {
  const { from_date, to_date, include_history } = query;
  if (include_history !== undefined && include_history !== 'true' && include_history !== 'false')
    invalid('include_history', '历史筛选只接受 true 或 false');
  return { from_date, to_date, include_history: include_history === 'true' };
}

// 导出作业查询和领取时，以当前请求身份重新核验账务范围。
export async function authorizeHourLedger(
  tx: Tx, actor: Actor, scope: HourLedgerScope,
): Promise<Pick<Prisma.HourRecordWhereInput, 'activity_id' | 'student_id'>> {
  if (scope.type === 'my_hours') return { student_id: studentId(actor) };
  if (scope.type === 'activity_hours') {
    if (!await tx.activity.findFirst({
      where: { id: scope.activity_id, ...managedScope(actor) }, select: { id: true },
    })) invisible();
    return { activity_id: scope.activity_id };
  }
  if (!staff(actor)) denied();
  if (!await tx.student.findUnique({ where: { id: scope.student_id }, select: { id: true } })) invisible();
  return { student_id: scope.student_id };
}

export const approvedOrigin = { OR: [
  { source_batch: { status: 'approved' } }, { source_group: { status: 'approved' } },
] } satisfies Prisma.HourRecordWhereInput;

export const hourRecordInclude = {
  student: { select: { student_no: true, account: { select: { display_name: true } } } },
  activity: { select: { activity_code: true } },
} as const;

export function hourRecordView(record: HourRecord & {
  student: { student_no: string; account: { display_name: string } };
  activity: { activity_code: string };
}, activity_title?: string): HourView {
  const { id, version, student_id, activity_id, status, service_date, hours, origin_schedule_revision,
    batch_id, supersedes_record_id, voided_by_batch_id, correction_group_id, voided_by_group_id, remark,
    created_at, updated_at, reviewed_at, student, activity } = record;
  return {
    id, version, student_id, activity_id, status: status as HourView['status'], service_date: dateText(service_date),
    credited_hours: hours.toFixed(1), origin_schedule_revision, student_no: student.student_no,
    student_name: student.account.display_name, activity_code: activity.activity_code,
    ...(activity_title && { activity_title }), ...(batch_id && { batch_id }),
    ...(supersedes_record_id && { supersedes_record_id }), ...(voided_by_batch_id && { voided_by_batch_id }),
    ...(correction_group_id && { correction_group_id }), ...(voided_by_group_id && { voided_by_group_id }),
    ...(remark && { remark }), ...(created_at && { created_at: created_at.toISOString() }),
    ...(updated_at && { updated_at: updated_at.toISOString() }), ...(reviewed_at && { reviewed_at: reviewed_at.toISOString() }),
  };
}

// 台账引用原获批版本，反馈引用活动当前获批版本。只取当前结果所需的标题。
export async function approvedTitles(tx: Tx, keys: { activity_id: string; revision: number | null }[]) {
  const key = (id: string, revision: number | null) => id + '/' + revision;
  const unique = new Map(keys.map((row) => [key(row.activity_id, row.revision), row]));
  const titles = unique.size ? await tx.$queryRaw<{ activity_id: string; revision: number; title: string | null }[]>`
    SELECT activity_id, revision, content->>'title' AS title
    FROM activity_revision
    JOIN jsonb_to_recordset(${JSON.stringify([...unique.values()])}::jsonb)
      AS wanted(activity_id uuid, revision int) USING (activity_id, revision)
    WHERE revision_state = 'approved'` : [];
  const byRevision = new Map(titles.map((row) => [key(row.activity_id, row.revision), row.title]));
  return (id: string, revision: number | null) => byRevision.get(key(id, revision)) ?? undefined;
}

export async function hourRecordViews(tx: Tx, records: Parameters<typeof hourRecordView>[0][]) {
  const title = await approvedTitles(tx, records.map((row) => ({
    activity_id: row.activity_id, revision: row.origin_schedule_revision,
  })));
  return records.map((row) => hourRecordView(row, title(row.activity_id, row.origin_schedule_revision)));
}

export function ledgerDateRange({ from_date, to_date }: HourLedgerFilters) {
  const start = from_date === undefined ? undefined : parseCalendarDate(from_date) ?? invalid('from_date', '请选择有效的起始日期');
  const end = to_date === undefined ? undefined : parseCalendarDate(to_date) ?? invalid('to_date', '请选择有效的结束日期');
  if (start && end && start > end) invalid('to_date', '结束日期须等于或晚于起始日期');
  return { gte: start, lte: end };
}

// 页面和 #18 导出传入各自的 RepeatableRead 事务。省略分页即读取整个筛选范围。
export async function readHourLedger(
  tx: Tx, actor: Actor, scope: HourLedgerScope, filters: HourLedgerFilters, page?: ReturnType<typeof pagination>,
) {
  return readHourLedgerWithScope(tx, await authorizeHourLedger(tx, actor, scope), filters, page);
}

/** 已完成范围核验后的全量/分页读取；导出生成使用保存的解析后范围，不再重新授权。 */
export async function readHourLedgerWithScope(
  tx: Tx,
  scopeWhere: Pick<Prisma.HourRecordWhereInput, 'activity_id' | 'student_id'>,
  filters: HourLedgerFilters,
  page?: ReturnType<typeof pagination>,
) {
  const where = { ...scopeWhere, ...approvedOrigin, service_date: ledgerDateRange(filters),
    ...(!filters.include_history && { status: 'current' }) };
  const records = await tx.hourRecord.findMany({
    where, include: hourRecordInclude,
    ...(page && { skip: page.skip, take: page.page_size }),
    orderBy: [{ service_date: 'desc' }, { created_at: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  });
  const items = await hourRecordViews(tx, records);
  if (!page) {
    const hours = records.reduce((sum, row) => row.status === 'current' ? sum.plus(row.hours) : sum, new Prisma.Decimal(0));
    return { items, total: records.length, total_hours: hours.toFixed(1) };
  }
  const groups = await tx.hourRecord.groupBy({ by: ['status'], where, _count: true, _sum: { hours: true } });
  const total = groups.reduce((count, group) => count + group._count, 0);
  const current = groups.find(group => group.status === 'current');
  return { items, total, total_hours: current?._sum.hours?.toFixed(1) ?? '0.0' };
}
