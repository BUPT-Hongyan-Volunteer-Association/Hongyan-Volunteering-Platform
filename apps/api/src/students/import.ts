import { readXlsxSheet, XlsxContentError, type SheetCell, type SheetRow } from './xlsx.js';

export const importSheetName = '学生建档';
export const maxImportBytes = 5_242_880;
export const maxImportRows = 5_000;

export const importFields = ['student_no', 'name', 'cohort', 'grade', 'class_name', 'college'] as const;
export type ImportField = (typeof importFields)[number];

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

export type ImportAction = 'create' | 'skip_identical' | 'error';

/** 规范化字段只在通过本字段格式校验时保留。 */
export interface NormalizedValues {
  student_no?: string;
  name?: string;
  cohort?: string;
  grade?: string;
  class_name?: string;
  college?: string;
}

export interface EvaluatedRow {
  row_number: number;
  action: ImportAction;
  values: NormalizedValues;
  raw_values: Record<string, string>;
  errors: FieldIssue[];
  resulting_account_status?: 'active' | 'inactive';
}

export interface ProfileValues {
  name?: string | null;
  cohort?: string | null;
  grade?: string | null;
  class_name?: string | null;
  college?: string | null;
}

/** 名单资料与已有档案是否完全一致；用于预览跳过判定与确认时复核。 */
export function profileMatches(
  values: ProfileValues,
  existing: ProfileValues,
  fields: readonly ImportField[],
) {
  return fields.every(field => field === 'student_no' || (values[field] ?? '') === (existing[field] ?? ''));
}

export interface ExistingStudent {
  student_no: string;
  /** 是否已有学生档案；仅有同名账号时不能当作可跳过的已有档案。 */
  has_record: boolean;
  name: string;
  cohort: string;
  grade: string;
  class_name: string;
  college: string;
  status: 'active' | 'inactive';
}

interface ParsedImport {
  fields?: ImportField[];
  /** 文件级问题：工作表、表头、行数或工作簿结构。 */
  file_error?: string;
  rows: ParsedRow[];
  row_count: number;
}

interface ParsedRow {
  row_number: number;
  values: NormalizedValues;
  raw_values: Record<string, string>;
  errors: FieldIssue[];
  /** 用于同键资料比较的原始文本，缺失记为空串。 */
  signature: Record<Exclude<ImportField, 'student_no'>, string>;
}

const fieldLabels: Record<ImportField, string> = {
  student_no: '学号',
  name: '姓名',
  cohort: '级部',
  grade: '年级',
  class_name: '班级',
  college: '学院',
};
const importFieldByHeader = new Map<string, ImportField>(
  importFields.map(field => [fieldLabels[field], field]),
);
const requiredImportFields: ImportField[] = ['student_no', 'name', 'grade', 'class_name'];

/** 学号前四位为入学年份；非 19xx/20xx 开头时不推断。 */
export function gradeFromStudentNo(student_no: string) {
  return /^((?:19|20)\d{2})/.exec(student_no)?.[1];
}

const text = (cell: SheetCell, field: ImportField, errors: FieldIssue[], max = 100) => {
  if (cell.type === 'formula') {
    errors.push({ field, code: 'formula_not_allowed', message: fieldLabels[field] + '不能使用公式' });
    return undefined;
  }
  if (cell.type !== 'text') {
    errors.push({
      field,
      code: 'not_text',
      message:
        field === 'student_no'
          ? '学号须按文本填写十位数字，数值型学号不会自动补零'
          : fieldLabels[field] + '须按文本填写',
    });
    return undefined;
  }
  const value = cell.text.trim();
  if (value.length > max) {
    errors.push({ field, code: 'too_long', message: fieldLabels[field] + '超过长度限制' });
    return undefined;
  }
  return value;
};

function columnName(index: number) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function parseRow(row: SheetRow, columns: Map<ImportField, number>): ParsedRow {
  const cells = new Map(row.cells.map(cell => [cell.column, cell]));
  const allowed = new Set(columns.values());
  const raw_values: Record<string, string> = {};
  const errors: FieldIssue[] = [];
  for (const cell of row.cells) {
    if (allowed.has(cell.column) || !cell.text) continue;
    const field = columnName(cell.column);
    raw_values[field] = cell.text;
    errors.push({ field, code: 'unknown_column', message: '表格之外的第 ' + field + ' 列有值' });
  }
  const values: NormalizedValues = {};
  const signature: ParsedRow['signature'] = { name: '', cohort: '', grade: '', class_name: '', college: '' };
  for (const field of importFields) {
    const column = columns.get(field);
    const cell = column === undefined ? undefined : cells.get(column);
    if (cell) raw_values[field] = cell.text;
    const max = field === 'grade' ? 50 : 100;
    if (field === 'student_no') {
      if (!cell) {
        errors.push({ field, code: 'required', message: '请填写学号' });
        continue;
      }
      const value = text(cell, field, errors);
      if (value === undefined) continue;
      if (!/^\d{10}$/.test(value))
        errors.push({ field, code: 'format', message: '学号须为十位数字，按文本保存并保留前导零' });
      else values.student_no = value;
      continue;
    }
    if (field === 'name') {
      if (!cell) {
        errors.push({ field, code: 'required', message: '请填写姓名' });
        continue;
      }
      const value = text(cell, field, errors);
      if (value === undefined) continue;
      signature.name = value;
      if (!value) errors.push({ field, code: 'required', message: '请填写姓名' });
      else values.name = value;
      continue;
    }
    if (!cell) continue;
    const value = text(cell, field, errors, max);
    if (value === undefined) continue;
    if (field === 'grade') {
      const grade = /^(\d{4})(?:级)?$/.exec(value)?.[1];
      if (value && !grade) {
        signature.grade = value;
        errors.push({
          field: 'grade',
          code: 'format',
          message: '年级须为四位年份（如 2026 或 2026级）',
        });
        continue;
      }
      signature.grade = grade ?? '';
      if (grade) values.grade = grade;
      continue;
    }
    signature[field] = value;
    if (field === 'class_name') {
      if (value && !/^\d{10}$/.test(value))
        errors.push({ field, code: 'format', message: '班级须为十位数字，按文本保存并保留前导零' });
      else if (value) values.class_name = value;
      continue;
    }
    if (value) values[field] = value;
  }
  if (!raw_values.grade?.trim()) {
    const derived = values.student_no ? gradeFromStudentNo(values.student_no) : undefined;
    if (derived) {
      values.grade = derived;
      signature.grade = derived;
    }
  }
  return { row_number: row.number, values, raw_values, errors, signature };
}

function importColumns(rows: SheetRow[]) {
  const header = rows.find(row => row.number === 1);
  if (!header) return;
  const columns = new Map<ImportField, number>();
  for (const cell of header.cells) {
    const field = cell.type === 'text' && importFieldByHeader.get(cell.text.trim());
    if (!field || columns.has(field)) return;
    columns.set(field, cell.column);
  }
  if (requiredImportFields.every(field => columns.has(field))) return columns;
}

/** 确认时从原文件读取实际表头，兼容此前已预览的批次。 */
export function readImportFields(buffer: Buffer) {
  const columns = importColumns(readXlsxSheet(buffer, importSheetName, true).rows);
  if (!columns) throw new XlsxContentError('已就绪批次的原文件表头无效');
  return [...columns.keys()];
}

/** 解析工作簿结构、工作表、表头和数据行；只做文件与行内格式校验。 */
export function parseImportWorkbook(buffer: Buffer): ParsedImport {
  let rows: SheetRow[];
  let truncated: boolean;
  try {
    ({ rows, truncated } = readXlsxSheet(buffer, importSheetName));
  } catch (error) {
    if (!(error instanceof XlsxContentError)) throw error;
    return { file_error: error.message, rows: [], row_count: 0 };
  }
  if (truncated)
    return { file_error: '数据行超过 5,000 条上限，请拆分后重新上传', rows: [], row_count: 0 };
  const columns = importColumns(rows);
  if (!columns)
    return {
      file_error:
        '第 1 行表头须包含 学号、姓名、年级、班级（级部兼容旧名单可选，学院可选），列顺序不限，且不使用其他列',
      rows: [],
      row_count: 0,
    };
  const data = rows.filter((row) => row.number >= 2);
  const parsed = data.map((row) => parseRow(row, columns));
  if (!parsed.length)
    return { file_error: '未找到可导入的数据行，请使用空白模板填写后重新上传', rows: [], row_count: 0 };
  if (parsed.length > maxImportRows)
    return { file_error: '数据行超过 5,000 条上限，请拆分后重新上传', rows: [], row_count: parsed.length };
  return { fields: [...columns.keys()], rows: parsed, row_count: parsed.length };
}

const signatureOf = (row: ParsedRow) =>
  JSON.stringify([
    row.signature.name,
    row.signature.cohort,
    row.signature.grade,
    row.signature.class_name,
    row.signature.college,
  ]);

/**
 * 依据文件内同键去重与已有学生档案判定每行动作。
 * 文件内同键不同资料的所有行都报冲突；完全相同的后续行跳过。
 */
export function evaluateRows(rows: ParsedRow[], existing: Map<string, ExistingStudent>, fields: ImportField[]): EvaluatedRow[] {
  const evaluated = new Map<number, EvaluatedRow>();
  for (const row of rows) {
    evaluated.set(row.row_number, {
      row_number: row.row_number,
      action: row.errors.length ? 'error' : 'create',
      values: row.values,
      raw_values: row.raw_values,
      errors: [...row.errors],
    });
  }
  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const student_no = row.values.student_no;
    if (!student_no) continue;
    const group = groups.get(student_no);
    if (group) group.push(row);
    else groups.set(student_no, [row]);
  }
  for (const [student_no, group] of groups) {
    const conflicted = group.length > 1 && new Set(group.map(signatureOf)).size > 1;
    if (conflicted) {
      const lines = group.map((row) => row.row_number).join('、');
      for (const row of group) {
        const target = evaluated.get(row.row_number)!;
        target.action = 'error';
        target.errors.push({
          field: 'student_no',
          code: 'duplicate_conflict',
          message: '学号 ' + student_no + ' 在第 ' + lines + ' 行的资料不一致',
        });
      }
      continue;
    }
    // 只对无错行去重：行级错误（未知列、格式错误等）不能被“相同资料跳过”掩盖。
    const clean = group.filter((row) => row.errors.length === 0);
    if (!clean.length) continue;
    const [first, ...duplicates] = clean;
    const firstRow = evaluated.get(first.row_number)!;
    let action: ImportAction = 'create';
    let status: 'active' | 'inactive' = 'active';
    const match = existing.get(student_no);
    if (match) {
      const same = match.has_record && profileMatches(first.values, match, fields);
      if (same) {
        action = 'skip_identical';
        status = match.status;
      } else {
        for (const row of clean) {
          const target = evaluated.get(row.row_number)!;
          target.action = 'error';
          target.errors = [
            ...target.errors,
            {
              field: 'student_no',
              code: 'profile_conflict',
              message: '已有学号 ' + student_no + ' 的学生资料与文件不一致，请在学生档案中修正',
            },
          ];
        }
        continue;
      }
    }
    firstRow.action = action;
    firstRow.resulting_account_status = status;
    for (const row of duplicates) {
      const target = evaluated.get(row.row_number)!;
      target.action = 'skip_identical';
      target.resulting_account_status = status;
    }
  }
  return [...evaluated.values()].sort((left, right) => left.row_number - right.row_number);
}

export function counts(rows: EvaluatedRow[]) {
  return {
    created_count: rows.filter((row) => row.action === 'create').length,
    skipped_count: rows.filter((row) => row.action === 'skip_identical').length,
    error_count: rows.filter((row) => row.action === 'error').length,
  };
}
