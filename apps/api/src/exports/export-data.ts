import type { ExportInput } from '@hongyan/contracts/types';
import { type Actor, studentId } from '../auth/session.guard.js';
import type { ExportJob } from '../generated/prisma/client.js';
import { managedScope, staff, workspaceScope } from '../activities/read.js';
import { rosterOrderBy, rosterWhere } from '../registrations/registration.js';
import { studentWhere } from '../students/query.js';
import type { Tx } from '../database.js';
import { denied, invalid, invisible } from '../http.js';
import { approvedOrigin, authorizeHourLedger, ledgerDateRange, readHourLedgerWithScope } from '../hours/read-ledger.js';
import {
  followUpEmpty,
  receiptWhere,
  type ReceiptStatus,
} from '../notices/receipts.js';
import { exportWorkbook, type ExportSheet } from '../workbook.js';

export const exportMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const registrationLabels: Record<string, string> = {
  accepted: '已录取',
  submitted: '已提交，待审核',
  waitlisted: '候补中',
  rejected: '未录取',
  withdrawn: '已撤回',
  exited: '已退出',
};
const receiptLabels: Record<string, string> = {
  unread: '未读',
  read: '已读未确认',
  acknowledged: '已确认',
};
const hourStatusLabels: Record<string, string> = {
  current: '当前有效',
  superseded: '已更正',
  voided: '已撤销',
};

// 已提交的旧导出任务继续遵守提交时保存的范围。
export type StoredScope = ExportInput & { student_id?: string; cohort?: string };

const beijing = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function dateText(value: Date) {
  const parts = Object.fromEntries(beijing.formatToParts(value).map((part) => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
function dateTimeText(value: Date) {
  const parts = Object.fromEntries(beijing.formatToParts(value).map((part) => [part.type, part.value]));
  return dateText(value) + ' ' + parts.hour + ':' + parts.minute;
}
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
function fileNamePart(value: string) {
  return value.replaceAll(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

/** 创建导出时解析并校验范围；保存解析后的 student_id 供生成任务使用。 */
export async function resolveExportScope(tx: Tx, actor: Actor, input: ExportInput): Promise<StoredScope> {
  if (input.type === 'activity_roster') {
    const activity_id = input.activity_id ?? invalid('activity_id', '请选择活动');
    const activity = await tx.activity.findFirst({
      where: { id: activity_id, ...workspaceScope(actor) },
      select: { id: true },
    });
    if (!activity) return invisible();
    const registration_ids = input.registration_ids;
    if (registration_ids) {
      const count = await tx.registration.count({
        where: { activity_id, id: { in: registration_ids } },
      });
      if (count !== registration_ids.length)
        invalid('registration_ids', '所选报名不在该活动名单范围内');
    }
    return compact({
      type: input.type,
      activity_id,
      registration_status: input.registration_status,
      q: input.q?.trim() || undefined,
      registration_ids,
    });
  }
  if (input.type === 'notice_receipts') {
    const notice_id = input.notice_id ?? invalid('notice_id', '请选择通知');
    const notice = await tx.notice.findFirst({
      where: { id: notice_id, activity: managedScope(actor) },
      select: { id: true },
    });
    if (!notice) return invisible();
    return compact({
      type: input.type,
      notice_id,
      receipt_status: input.receipt_status,
      follow_up_only: input.follow_up_only ?? false,
    });
  }
  if (input.type === 'activity_hours') {
    const activity_id = input.activity_id ?? invalid('activity_id', '请选择活动');
    await authorizeHourLedger(tx, actor, { type: 'activity_hours', activity_id });
    const student_ids = input.student_ids;
    if (student_ids) {
      const count = await tx.student.count({
        where: {
          id: { in: student_ids },
          hour_records: { some: { activity_id, ...approvedOrigin } },
        },
      });
      if (count !== student_ids.length)
        invalid('student_ids', '所选学生不在该活动时长范围内');
    }
    return compact({
      type: input.type,
      activity_id,
      from_date: input.from_date,
      to_date: input.to_date,
      include_history: input.include_history ?? false,
      student_ids,
    });
  }
  if (input.type === 'my_hours') {
    const student_id = studentId(actor);
    return compact({
      type: input.type,
      student_id,
      from_date: input.from_date,
      to_date: input.to_date,
      include_history: input.include_history ?? false,
    });
  }
  if (input.type === 'admin_students') {
    if (!staff(actor)) denied();
    const student_ids = input.student_ids;
    if (student_ids) {
      const count = await tx.student.count({ where: { id: { in: student_ids } } });
      if (count !== student_ids.length) invalid('student_ids', '所选学生不存在');
    }
    return compact({
      type: input.type,
      q: input.q?.trim() || undefined,
      grade: input.grade,
      account_status: input.account_status,
      student_ids,
    });
  }
  const student_id = input.student_id ?? invalid('student_id', '请选择学生');
  await authorizeHourLedger(tx, actor, { type: 'admin_student_hours', student_id });
  return compact({
    type: input.type,
    student_id,
    from_date: input.from_date,
    to_date: input.to_date,
    include_history: input.include_history ?? false,
  });
}

/** 查询、下载时按保存的范围重新核验当前权限。 */
export async function authorizeStoredScope(tx: Tx, actor: Actor, scope: StoredScope) {
  if (scope.type === 'activity_roster') {
    if (!await tx.activity.findFirst({
      where: { id: scope.activity_id!, ...workspaceScope(actor) }, select: { id: true },
    })) invisible();
    return;
  }
  if (scope.type === 'notice_receipts') {
    if (!await tx.notice.findFirst({
      where: { id: scope.notice_id!, activity: managedScope(actor) }, select: { id: true },
    })) invisible();
    return;
  }
  if (scope.type === 'activity_hours') {
    await authorizeHourLedger(tx, actor, { type: 'activity_hours', activity_id: scope.activity_id! });
    return;
  }
  if (scope.type === 'my_hours') {
    const current = studentId(actor);
    if (scope.student_id !== current) invisible();
    return;
  }
  if (scope.type === 'admin_students') {
    if (!staff(actor)) denied();
    return;
  }
  await authorizeHourLedger(tx, actor, { type: 'admin_student_hours', student_id: scope.student_id! });
}

export interface ExportContent {
  sheet: ExportSheet;
  fileName: string;
}

function workbookDate() {
  return dateText(new Date());
}

async function rosterContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  const activity_id = scope.activity_id!;
  const activity = await tx.activity.findUnique({
    where: { id: activity_id }, select: { activity_code: true },
  });
  if (!activity) return invisible();
  const rows = await tx.registration.findMany({
    where: rosterWhere({
      activity_id,
      q: scope.q,
      status: scope.registration_status,
      registration_ids: scope.registration_ids,
    }),
    include: { student: { select: { student_no: true, account: { select: { display_name: true } } } } },
    orderBy: rosterOrderBy,
  });
  return {
    fileName: '报名名单_' + fileNamePart(activity.activity_code) + '_' + workbookDate() + '.xlsx',
    sheet: {
      name: '报名名单',
      headers: ['姓名', '学号', '申请时间', '当前报名状态'],
      widths: [18, 18, 22, 20],
      rows: rows.map((row) => [
        row.student.account.display_name,
        row.student.student_no,
        dateTimeText(row.submitted_at),
        registrationLabels[row.status] ?? row.status,
      ]),
    },
  };
}

async function receiptContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  const notice_id = scope.notice_id!;
  const notice = await tx.notice.findUnique({
    where: { id: notice_id },
    select: {
      id: true, title: true, information_version: true, is_current: true, requires_ack: true,
      notice_kind: true, activity_id: true,
      activity: { select: { activity_code: true } },
    },
  });
  if (!notice) return invisible();
  const filters = {
    status: scope.receipt_status as ReceiptStatus | undefined,
    follow_up_only: scope.follow_up_only ?? false,
  };
  const rows = followUpEmpty(notice, filters)
    ? []
    : await tx.noticeReceipt.findMany({
        where: receiptWhere(notice, filters),
        include: {
          student: { select: { student_no: true, account: { select: { display_name: true } } } },
        },
        orderBy: { student: { student_no: 'asc' } },
      });
  return {
    fileName: '通知回执_' + fileNamePart(notice.activity.activity_code) + '_' + workbookDate() + '.xlsx',
    sheet: {
      name: '通知回执',
      notes: ['通知：' + notice.title, '版本：第 ' + notice.information_version + ' 版'],
      headers: ['学号', '姓名', '回执状态', '已读时间', '确认时间'],
      widths: [18, 18, 18, 22, 22],
      rows: rows.map((row) => [
        row.student.student_no,
        row.student.account.display_name,
        receiptLabels[row.acknowledged_at ? 'acknowledged' : row.read_at ? 'read' : 'unread'],
        row.read_at ? dateTimeText(row.read_at) : '',
        row.acknowledged_at ? dateTimeText(row.acknowledged_at) : '',
      ]),
    },
  };
}

async function selectedSummaryContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  const activity = await tx.activity.findUnique({
    where: { id: scope.activity_id! }, select: { activity_code: true },
  });
  if (!activity) return invisible();
  const ids = scope.student_ids!;
  const students = await tx.student.findMany({
    where: { id: { in: ids } },
    select: { id: true, student_no: true, account: { select: { display_name: true } } },
  });
  if (students.length !== ids.length) return invisible();
  const totals = await tx.hourRecord.groupBy({
    by: ['student_id'],
    where: {
      ...approvedOrigin,
      activity_id: scope.activity_id!,
      student_id: { in: ids },
      status: 'current',
      service_date: ledgerDateRange(scope),
    },
    _sum: { hours: true },
  });
  const sums = new Map(totals.map((row) => [row.student_id, row._sum.hours?.toNumber() ?? 0]));
  return {
    fileName: '活动时长汇总_' + fileNamePart(activity.activity_code) + '_' + workbookDate() + '.xlsx',
    sheet: {
      name: '学生时长汇总',
      headers: ['姓名', '学号', '合计时长（小时）'],
      widths: [20, 18, 18],
      rows: students
        .sort((left, right) => left.student_no.localeCompare(right.student_no))
        .map((student) => [
          student.account.display_name,
          student.student_no,
          sums.get(student.id) ?? 0,
        ]),
    },
  };
}

async function hoursContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  if (scope.student_ids?.length) return selectedSummaryContent(tx, scope);
  const single = scope.type === 'my_hours' || scope.type === 'admin_student_hours';
  const student_id = scope.student_id!;
  const activity_id = scope.activity_id!;
  const student = single
    ? await tx.student.findUnique({
        where: { id: student_id },
        select: { student_no: true, account: { select: { display_name: true } } },
      })
    : undefined;
  if (single && !student) return invisible();
  const result = await readHourLedgerWithScope(
    tx,
    single ? { student_id } : { activity_id },
    {
      from_date: scope.from_date,
      to_date: scope.to_date,
      include_history: scope.include_history ?? false,
    },
  );
  const activity = single
    ? undefined
    : await tx.activity.findUnique({
        where: { id: activity_id }, select: { activity_code: true },
      });
  if (!single && !activity) return invisible();
  const headers = single
    ? ['活动名称', '活动编号', '服务日期', '时长（小时）', '记录状态']
    : ['姓名', '学号', '活动名称', '活动编号', '服务日期', '时长（小时）', '记录状态'];
  const valueIndex = single ? 3 : 5;
  const note = single && student
    ? ['学生：' + student.account.display_name + '（' + student.student_no + '）']
    : undefined;
  const fileName = single
    ? (scope.type === 'my_hours' ? '本人时长_' : '学生时长_') +
      fileNamePart(student!.student_no) + '_' + workbookDate() + '.xlsx'
    : '活动时长_' + fileNamePart(activity!.activity_code) + '_' + workbookDate() + '.xlsx';
  return {
    fileName,
    sheet: {
      name: '志愿时长',
      ...(note && { notes: note }),
      headers,
      widths: single ? [28, 16, 16, 16, 14] : [18, 18, 28, 16, 16, 16, 14],
      rows: result.items.map((row) => [
        ...(single ? [] : [row.student_name ?? '', row.student_no ?? '']),
        row.activity_title ?? '',
        row.activity_code,
        row.service_date,
        Number(row.credited_hours),
        hourStatusLabels[row.status] ?? row.status,
      ]),
      total: {
        label: '合计（仅当前有效记录）',
        value: Number(result.total_hours),
        valueIndex,
      },
    },
  };
}

async function studentsContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  const rows = await tx.student.findMany({
    where: {
      ...studentWhere({ q: scope.q, grade: scope.grade, status: scope.account_status, student_ids: scope.student_ids }),
      ...(scope.cohort && { cohort: scope.cohort }),
    },
    include: { account: { select: { display_name: true, active: true } } },
    orderBy: { student_no: 'asc' },
  });
  const hasCohort = rows.some(row => row.cohort?.trim());
  return {
    fileName: '学生档案_' + workbookDate() + '.xlsx',
    sheet: {
      name: '学生档案',
      headers: ['学号', '姓名', ...(hasCohort ? ['级部'] : []), '年级', '班级', '学院', '账号状态'],
      widths: [18, 18, ...(hasCohort ? [16] : []), 12, 18, 24, 12],
      rows: rows.map((row) => [
        row.student_no,
        row.account.display_name,
        ...(hasCohort ? [row.cohort ?? ''] : []),
        row.grade ?? '',
        row.class_name ?? '',
        row.college ?? '',
        row.account.active ? '启用' : '停用',
      ]),
    },
  };
}

export async function exportContent(tx: Tx, scope: StoredScope): Promise<ExportContent> {
  if (scope.type === 'activity_roster') return rosterContent(tx, scope);
  if (scope.type === 'notice_receipts') return receiptContent(tx, scope);
  if (scope.type === 'admin_students') return studentsContent(tx, scope);
  return hoursContent(tx, scope);
}

export function exportBuffer(sheet: ExportSheet) {
  return Buffer.from(exportWorkbook(sheet));
}

/** 导出输入只允许契约中的字段；用于拒绝未知筛选参数。 */
export function exportedScope(job: Pick<ExportJob, 'scope'>): StoredScope {
  return job.scope as unknown as StoredScope;
}
