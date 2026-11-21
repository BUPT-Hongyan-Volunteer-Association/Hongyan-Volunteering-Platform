import type { ActivitySchedule, FieldError, HourRow, HourWarning } from '@hongyan/contracts/types';
import { invalid } from '../http.js';
import { beijingDay, hours, hourTenths, normalizeFact, scheduleCoverage, serviceDate } from './values.js';
import type { HourInputRow } from './workbook.js';

type Flag = NonNullable<HourRow['misconduct_reported']>;
export interface HourHistory {
  id: string; version: number; activity_id: string; student_id: string; service_date: string;
  status: 'current' | 'voided'; hours: string; origin_schedule_revision: number;
  misconduct_reported: Flag; misconduct_fact?: string; misconduct_version: number;
  reusable_facts?: readonly string[];
}
interface RegistrationState {
  status: string; submitted_at: Date; changed_at?: Date | null;
}
export interface HourSnapshot {
  activity_id: string; activity_code: string; published_revision: number | null;
  students: readonly { id: string; student_no: string; name: string; registration: readonly RegistrationState[] }[];
  approved_schedules: readonly { revision: number; schedule: ActivitySchedule }[];
  history: readonly HourHistory[];
}
export interface PreviewOptions { mode: 'new' | 'correction'; schedule_revision?: number; now: Date }
type PreviewRow = Omit<HourRow, 'action' | 'errors' | 'warnings'> & {
  action: HourRow['action']; errors: FieldError[]; warnings: HourWarning[];
};
const text = (raw: HourInputRow['remark']) => raw?.type === 'text' ? raw.value : undefined;
const fail = (row: PreviewRow, field: string, message: string) => {
  row.errors.push({ row: row.row_number, field, code: 'validation_error', message });
};

function registeredOnDay(history: readonly RegistrationState[], day: string) {
  const start = Date.parse(day + 'T00:00:00+08:00');
  const end = start + 86_400_000;
  const effectiveTime = (state: RegistrationState) => (state.changed_at ?? state.submitted_at).getTime();
  // 工作簿只记录日期。有效报名与该北京时间自然日须有正交集。
  return history.some((state, index) => {
    if (!['submitted', 'waitlisted', 'accepted'].includes(state.status)) return false;
    const next = history[index + 1];
    return Math.max(start, effectiveTime(state)) < Math.min(end, next ? effectiveTime(next) : Infinity);
  });
}

function inspect({ row_number, errors = [], ...input }: HourInputRow, system: '1900' | '1904', today: string, activity: string,
  students: Map<string, HourSnapshot['students'][number]>) {
  const row: PreviewRow = { row_number, action: 'error', errors: [...errors], warnings: [],
    raw_values: Object.fromEntries(Object.entries(input)
      .map(([field, cell]) => [field, cell === 'not_provided' ? cell : cell?.value ?? ''])) };
  const studentNo = text(input.student_no), student = students.get(studentNo ?? '');
  if (!studentNo || !/^\d{10}$/.test(studentNo)) fail(row, 'student_no', '学号必须是十位数字文本');
  else {
    row.student_no = studentNo;
    if (!student) fail(row, 'student_no', '找不到该学生档案');
  }
  row.student_name = text(input.student_name);
  if (!row.student_name || (student && student.name !== row.student_name)) fail(row,'student_name','姓名为空或与档案不一致');
  row.activity_code = text(input.activity_code);
  if (row.activity_code !== activity) fail(row,'activity_code','活动编号与当前活动不一致');
  const day = serviceDate(input.service_date, system);
  if (!day || day > today) fail(row,'service_date','须为真实且非未来的整日日期');
  if (day) row.service_date = day;
  const value = hourTenths(input.credited_hours);
  if (value === null) fail(row,'credited_hours','须为 0.1–999.9 的数值，最多一位小数');
  else row.credited_hours = hours(value);
  const rawFlag = input.misconduct_reported;
  row.misconduct_reported = rawFlag === 'not_provided' ? rawFlag : text(rawFlag) === '有' ? 'reported'
    : text(rawFlag) === '无' ? 'none' : undefined;
  if (!row.misconduct_reported) fail(row,'misconduct_reported','七列表必须填写“无”或“有”');
  row.remark = text(input.remark);
  if (input.remark && (row.remark === undefined || [...row.remark].length > 2000)) {
    fail(row,'remark','备注须为不超过 2000 字的文本');
    row.remark = undefined;
  }
  const fact = normalizeFact(row.remark ?? '');
  if (!fact && (row.misconduct_reported === 'reported' ||
    (student && (day ? !registeredOnDay(student.registration, day) : !student.registration.length)))) {
    fail(row, 'remark', '违纪上报或未报名补录须说明事实');
  }
  const key = student && day && row.activity_code === activity ? student.id + '/' + day : undefined;
  const comparison = {
    credited_hours: JSON.stringify(value ?? input.credited_hours),
    misconduct_reported: JSON.stringify(row.misconduct_reported ?? rawFlag),
    remark: row.misconduct_reported === 'reported' ? fact : '',
  };
  return { row, student, key, comparison, day, value, fact };
}

function indexHistory(snapshot: HourSnapshot) {
  const existing = new Map<string, { record: HourHistory; effective: number }>();
  const daily = new Map<string, number>();
  for (const record of snapshot.history) {
    const key = record.student_id + '/' + record.service_date;
    const amount = record.status === 'voided' ? 0 : hourTenths({ type: 'number', value: record.hours });
    if (amount === null) throw Error('历史有效时长不符合契约');
    daily.set(key, (daily.get(key) ?? 0) + amount);
    if (record.activity_id === snapshot.activity_id) {
      existing.set(key, { record, effective: amount });
    }
  }
  return { existing, daily };
}

export function previewHourRows(book: { rows: readonly HourInputRow[]; date_system: '1900' | '1904' },
  snapshot: HourSnapshot, options: PreviewOptions) {
  if (options.mode === 'correction' && options.schedule_revision !== undefined) invalid('schedule_revision','更正批次不能指定新安排');
  const selected = options.schedule_revision ?? snapshot.published_revision;
  const students = new Map(snapshot.students.map((student) => [student.student_no, student]));
  const today = beijingDay(options.now), coverage = scheduleCoverage(snapshot.approved_schedules);
  const { existing, daily } = indexHistory(snapshot);
  const inputs = book.rows.map((input) => inspect(input, book.date_system, today, snapshot.activity_code, students));
  type Compared = keyof typeof inputs[number]['comparison'];
  const groups = new Map<string, {
    first: PreviewRow; accepted?: PreviewRow; values: Record<Compared,string>; conflicts: Set<Compared>;
  }>();
  for (const { key, row, comparison } of inputs) {
    if (!key) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { first: row, values: comparison, conflicts: new Set() });
    else for (const field of ['credited_hours','misconduct_reported','remark'] as const) {
      if (group.values[field] !== comparison[field]) group.conflicts.add(field);
    }
  }
  let total = 0;
  for (const { row, key, student, day, fact, value } of inputs) {
    if (options.mode === 'correction' && !fact && !row.errors.some((error) => error.field === 'remark')) {
      fail(row,'remark','更正须填写说明');
    }
    if (!key || !student || !day) continue;
    const group = groups.get(key)!;
    const prior = existing.get(key), record = prior?.record, previous = prior?.effective ?? 0;
    const revision = record?.origin_schedule_revision ?? selected;
    const duration = coverage(revision, day);
    if (duration === 0) fail(row,'service_date','服务日期不在适用的获批安排内');
    if (revision !== null) row.bound_schedule_revision = revision;
    if (record) {
      row.existing_record_id = record.id;
      row.existing_version = record.version;
      row.previous_misconduct_reported = record.misconduct_reported;
    }
    row.previous_hours = hours(previous);
    row.misconduct_version = record?.misconduct_version ?? 0;
    const reported = row.misconduct_reported === 'reported';
    row.misconduct_requires_review = reported
      && !record?.reusable_facts?.some((old) => normalizeFact(old) === fact);
    for (const field of group.conflicts) fail(row,field,'同学生、活动和服务日期的记录在此字段冲突');
    if (group.conflicts.size) continue;
    if (!record && options.mode === 'correction') fail(row,'service_date','同键无原记录，无法更正');
    if (value === null) continue;
    if (record && (record.status === 'voided' || value !== previous) && options.mode !== 'correction') {
      fail(row,'credited_hours','修改时长或恢复已撤销记录须使用更正模式');
    }
    if (group.accepted && row.errors.length === 0) {
      row.action = 'skip_identical';
      row.delta_hours = '0.0';
      continue;
    }
    if (!record) row.action = 'add';
    else if (record.status === 'voided' || previous !== value) row.action = 'correct';
    else if (row.misconduct_reported && row.misconduct_reported !== 'not_provided' && (record.misconduct_reported !== row.misconduct_reported ||
      (reported && (normalizeFact(record.misconduct_fact ?? '') !== fact || row.misconduct_requires_review)))) row.action = 'review_only';
    else row.action = 'skip_identical';
    const delta = row.action === 'skip_identical' ? 0 : value - previous;
    if (row.action !== 'skip_identical' && duration !== 0) {
      const projected = (daily.get(key) ?? 0) + delta;
      const warn = (code: HourWarning['code'], message: string, amount: Partial<HourWarning>) =>
        row.warnings.push({ warning_id: [code, student.id, day, row.row_number].join(':'),
          code, student_id: student.id, service_date: day, row_numbers: [row.row_number],
          message, ...(fact && { explanation: fact }), ...amount });
      if (duration !== null && value * 360000 > duration) warn('exceeds_planned_hours','预计时长超过当天计划覆盖时长',{ planned_hours: String(duration / 3600000) });
      if (projected > 240) warn('daily_total_exceeds_24','该学生跨活动当日预计超过 24 小时',{ projected_daily_hours: hours(projected) });
      if (row.warnings.length && !fact && !row.errors.some((error) => error.field === 'remark')) fail(row,'remark','时长警告须填写说明');
    }
    if (row.errors.length) row.action = 'error';
    else {
      group.accepted = row;
      total += delta;
      row.delta_hours = hours(delta);
    }
  }
  // Identical reports belong to the counted row, or the first original row if all are invalid.
  for (const { row, key } of inputs) {
    if (!key || !row.misconduct_requires_review) continue;
    const group = groups.get(key)!;
    if (!group.conflicts.size) row.misconduct_requires_review = row === (group.accepted ?? group.first);
  }
  const rows = inputs.map(({ row }) => row);
  const error_count = rows.filter((row) => row.action === 'error').length;
  const skipped_count = rows.filter((row) => row.action === 'skip_identical').length;
  return { rows, row_count: rows.length, valid_count: rows.length - error_count - skipped_count, skipped_count,
    error_count, review_only_count: rows.filter((row) => row.action === 'review_only').length,
    misconduct_flagged_count: rows.filter((row) => row.misconduct_reported === 'reported').length,
    misconduct_review_required_count: rows.filter((row) => row.misconduct_requires_review).length,
    warnings: rows.flatMap((row) => row.warnings), projected_delta_hours: hours(total) };
}
