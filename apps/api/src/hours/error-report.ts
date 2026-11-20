import { strToU8, zipSync } from 'fflate';
import type { FieldError } from '@hongyan/contracts/types';

const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const docNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function errorWorkbook(errors: FieldError[]) {
  const rows = [['原表行号','字段','错误原因'], ...errors.map((err) => [String(err.row ?? ''), err.field ?? 'file', err.message])];
  const sheet = rows.map((cells, index) => `<row r="${index+1}">${cells.map((value, col) =>
    `<c r="${String.fromCharCode(65+col)}${index+1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('');
  const xml = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/errors.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${relNs}"><Relationship Id="book" Type="${docNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${sheetNs}" xmlns:r="${docNs}"><sheets><sheet name="校验错误" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relNs}"><Relationship Id="sheet" Type="${docNs}/worksheet" Target="worksheets/errors.xml"/></Relationships>`,
    'xl/worksheets/errors.xml': `<worksheet xmlns="${sheetNs}"><cols><col min="1" max="2" width="20" customWidth="1"/><col min="3" max="3" width="64" customWidth="1"/></cols><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(xml).map(([key,value]) => [key,strToU8(value)])));
}
