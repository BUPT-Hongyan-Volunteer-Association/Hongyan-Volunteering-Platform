import { strToU8, zipSync } from 'fflate';

const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const docNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';

function escapeText(value: string) {
  const controls = [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31));
  });
  return controls
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .slice(0, 32767);
}

function columnName(index: number) {
  let name = '';
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26))
    name = String.fromCharCode(65 + ((current - 1) % 26)) + name;
  return name;
}

export type ExportCell = string | number;

function cell(column: number, row: number, value: ExportCell) {
  const ref = columnName(column) + row;
  if (typeof value === 'number')
    return '<c r="' + ref + '"><v>' + value + '</v></c>';
  return '<c r="' + ref + '" t="inlineStr"><is><t>' + escapeText(value) + '</t></is></c>';
}

function rowXml(row: number, cells: ExportCell[]) {
  const content = cells.map((value, column) => (value === '' ? '' : cell(column, row, value))).join('');
  return '<row r="' + row + '">' + content + '</row>';
}

export interface ExportSheet {
  name: string;
  /** 内部工作表部件名，默认 export；兼容既有错误报告的 errors.xml。 */
  worksheet?: string;
  notes?: ExportCell[];
  headers: ExportCell[];
  rows: ExportCell[][];
  widths?: number[];
  /** 合计行：标签写在第一列，合计值写在 valueIndex 列。 */
  total?: { label: ExportCell; value: ExportCell; valueIndex: number };
}

export function exportWorkbook(sheet: ExportSheet) {
  const rows: string[] = [];
  let row = 0;
  for (const note of sheet.notes ?? []) rows.push(rowXml(++row, [note]));
  if (sheet.notes?.length) rows.push('<row r="' + ++row + '"></row>');
  rows.push(rowXml(++row, sheet.headers));
  for (const item of sheet.rows) rows.push(rowXml(++row, item));
  if (sheet.total) {
    const cells: ExportCell[] = Array.from(
      { length: Math.max(sheet.headers.length, sheet.total.valueIndex + 1) },
      () => '',
    );
    cells[0] = sheet.total.label;
    cells[sheet.total.valueIndex] = sheet.total.value;
    rows.push(rowXml(++row, cells));
  }
  const worksheet = sheet.worksheet ?? 'export';
  const widths = sheet.widths ?? sheet.headers.map(() => 18);
  const cols = '<cols>' + widths.map((width, index) =>
    '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>').join('') + '</cols>';
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="' + contentTypes + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/' + worksheet + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="' + relNs + '"><Relationship Id="book" Type="' + docNs + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="' + sheetNs + '" xmlns:r="' + docNs + '"><sheets><sheet name="' +
      escapeText(sheet.name) + '" sheetId="1" r:id="sheet"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="' + relNs + '"><Relationship Id="sheet" Type="' + docNs + '/worksheet" Target="worksheets/' + worksheet + '.xml"/></Relationships>',
    ['xl/worksheets/' + worksheet + '.xml']:
      '<worksheet xmlns="' + sheetNs + '">' + cols + '<sheetData>' + rows.join('') + '</sheetData></worksheet>',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}