import type { FieldError } from '@hongyan/contracts/types';
import { BusinessError, invalid } from '../http.js';
import { attr, readHourParts, scan } from './ooxml.js';

const headers = ['学号', '姓名', '活动编号', '服务日期', '认证时长（小时）', '备注', '是否有违纪情况'];
type Cell = { type: 'text' | 'number' | 'boolean' | 'date' | 'error'; value: string };
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

function sharedStrings(xml: string | null, spreadsheet: string) {
  const strings: string[] = [];
  if (!xml) return strings;
  let value = '', reading = false;
  scan(xml, {
    open(tag, parent) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'si') value = '';
      if (tag.local === 't') reading = parent?.local === 'si' || parent?.local === 'r';
    },
    text(text) { if (reading) value += text; },
    close(tag) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 't') reading = false;
      if (tag.local === 'si') strings.push(value);
    },
  });
  return strings;
}

function decode(type: string, value: string, strings: string[], ref: string,
  report: (at: string, message: string) => null): Raw {
  if (value === '') return null;
  switch (type) {
    case 's': {
      if (!/^\d+$/.test(value) || strings[Number(value)] === undefined) return report(ref, '共享字符串索引无效');
      return strings[Number(value)] === '' ? null : { type: 'text', value: strings[Number(value)] };
    }
    case 'inlineStr':
    case 'str': return { type: 'text', value };
    case 'n': return { type: 'number', value };
    case 'b': return { type: 'boolean', value };
    case 'd': return { type: 'date', value };
    case 'e': return { type: 'error', value };
    default: return report(ref, '不支持的单元格类型');
  }
}

export async function parseHourWorkbook(filename: string, bytes: Buffer) {
  if (!/\.xlsx$/i.test(filename)) invalid('file', '只接受 .xlsx 工作簿');
  if (bytes.length > 5242880) invalid('file', '工作簿不能超过 5 MB');
  const parts = await readHourParts(bytes);
  const { spreadsheet } = parts;
  const strings = sharedStrings(parts.shared, spreadsheet);
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
  let width = 0, rowNumber = 0, column = 0, rowIssueStart = 0;
  let inData = false, inRow = false, reading = false;
  let cells: Raw[] = [];
  let cell: { ref: string; type: string; value: string } | undefined;
  scan(parts.sheet, {
    open(tag, parent) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'sheetData' && parent?.local === 'worksheet') inData = true;
      if (!inData) return;
      if (tag.local === 'row' && parent?.local === 'sheetData') {
        const next = Number(attr(tag, 'r') ?? rowNumber + 1);
        if (!Number.isInteger(next) || next <= rowNumber || next > 1048576) bad('时长录入', '原表行号无效');
        if (!width && next !== 1) bad('第 1 行', '缺少表头');
        rowNumber = next;
        rowIssueStart = issues.length;
        column = 0;
        cells = [];
        nonempty = false;
        inRow = true;
      }
      if (!inRow) return;
      if (tag.local === 'c' && parent?.local === 'row') {
        const address = attr(tag, 'r');
        if (address !== undefined) {
          const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
          if (!match || Number(match[2]) !== rowNumber) return bad(address, '单元格地址与行号不一致');
          const next = [...match[1]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
          if (next <= column || next > 16384) bad(address, '单元格列号无效');
          column = next;
        } else {
          column++;
        }
        cell = { ref: address ?? `R${rowNumber}C${column}`, type: attr(tag, 't') ?? 'n', value: '' };
      }
      if (cell && tag.local === 'f') report(cell.ref, '不接受公式');
      if (cell && (tag.local === 'v' && parent?.local === 'c' || tag.local === 't' && ['is', 'r'].includes(parent?.local ?? ''))) reading = true;
    },
    text(value) { if (reading && cell) cell.value += value; },
    close(tag) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'v' || tag.local === 't') reading = false;
      if (tag.local === 'c' && cell) {
        const value = decode(cell.type, cell.value, strings, cell.ref, report);
        if (value) {
          nonempty = true;
          if (column > (width || 7)) report(cell.ref, '未知列存在数据');
          else cells[column - 1] = value;
        }
        cell = undefined;
      }
      if (tag.local === 'row' && inRow) {
        inRow = false;
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
      }
      if (tag.local === 'sheetData') inData = false;
    },
  });
  if (!width) bad('第 1 行', '缺少时长录入表头');
  const template_structure: Structure = width === 6 ? 'legacy_hours_6' : 'hours_misconduct_7';
  return { template_structure, date_system: parts.date_system, rows };
}
