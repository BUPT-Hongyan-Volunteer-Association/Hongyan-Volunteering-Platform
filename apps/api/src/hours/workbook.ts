import type { FieldError } from '@hongyan/contracts/types';
import { BusinessError, invalid } from '../http.js';
import { readSheetParts, scanSheet, type Cell } from '../ooxml.js';

const headers = ['学号', '姓名', '活动编号', '服务日期', '认证时长（小时）', '备注', '是否有违纪情况'];
type Raw = Cell | null;
type Structure = 'legacy_hours_6' | 'hours_misconduct_7';
export interface HourInputRow {
  row_number: number;
  errors?: FieldError[];
  student_no: Raw;
  student_name: Raw;
  activity_code: Raw;
  service_date: Raw;
  credited_hours: Raw;
  remark: Raw;
  misconduct_reported: Raw | 'not_provided';
}

function workbookIssue(at: string, message: string) {
  const match = /^(?:[A-Z]+(\d+)|R(\d+)C\d+|第 (\d+) 行)$/.exec(at);
  const row = match && Number(match[1] ?? match[2] ?? match[3]);
  return { field: at, ...(row && { row }), code: 'validation_error', message };
}

function rejectIssues(issues: ReturnType<typeof workbookIssue>[]): never {
  const first = issues[0];
  const count = issues.length > 1 ? `（共 ${issues.length} 处，详见错误报告）` : '';
  throw new BusinessError(422, 'validation_error', first.field + '：' + first.message + count, issues);
}

export async function parseHourWorkbook(filename: string, bytes: Buffer) {
  if (!/\.xlsx$/i.test(filename)) invalid('file', '只接受 .xlsx 工作簿');
  if (bytes.length > 5242880) invalid('file', '工作簿不能超过 5 MB');
  const parts = await readSheetParts(bytes, '时长录入', { rejectTotals: true });
  const rows: HourInputRow[] = [];
  const issues: ReturnType<typeof workbookIssue>[] = [];
  let nonempty = false;
  function report(at: string, message: string) {
    issues.push(workbookIssue(at, message));
    nonempty = true;
    return null;
  }
  function bad(at: string, message: string): never {
    report(at, message);
    return rejectIssues(issues);
  }
  let width = 0, rowIssueStart = 0;
  let cells: Raw[] = [];
  scanSheet(parts, {
    startRow(number) {
      if (!width && number !== 1) bad('第 1 行', '缺少表头');
      rowIssueStart = issues.length;
      nonempty = false;
      cells = [];
    },
    report,
    bad,
    cell(column, ref, value) {
      nonempty = true;
      if (column > (width || 7)) report(ref, '未知列存在数据');
      else cells[column - 1] = value;
    },
    endRow(rowNumber) {
      if (rowNumber === 1) {
        width = cells.length;
        if (![6, 7].includes(width) || headers.slice(0, width).some((name, index) =>
          cells[index]?.type !== 'text' || cells[index]?.value !== name)) bad('第 1 行', '不符合七列或旧六列表头');
        if (issues.length) rejectIssues(issues);
      } else if (nonempty) {
        if (rows.length >= 5000) bad('第 ' + rowNumber + ' 行', '超过 5000 条非空记录');
        if (['合计', '总计'].includes(cells[0]?.value.trim() ?? '')) report('第 ' + rowNumber + ' 行', '不接受合计行');
        rows.push({
          row_number: rowNumber, ...(issues.length > rowIssueStart && { errors: issues.slice(rowIssueStart) }),
          student_no: cells[0] ?? null, student_name: cells[1] ?? null,
          activity_code: cells[2] ?? null, service_date: cells[3] ?? null, credited_hours: cells[4] ?? null,
          remark: cells[5] ?? null, misconduct_reported: width === 6 ? 'not_provided' : cells[6] ?? null,
        });
      }
    },
  });
  if (!width) bad('第 1 行', '缺少时长录入表头');
  const template_structure: Structure = width === 6 ? 'legacy_hours_6' : 'hours_misconduct_7';
  return { template_structure, date_system: parts.date_system, rows };
}
