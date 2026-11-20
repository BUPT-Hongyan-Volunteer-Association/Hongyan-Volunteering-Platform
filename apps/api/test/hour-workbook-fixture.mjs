import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export const template = readFileSync(new URL('../../../packages/contracts/templates/志愿时长录入模板_v1.5.xlsx', import.meta.url));
const source = unzipSync(template);
export const sheet = 'xl/worksheets/sheet1.xml';
export const headers = ['学号', '姓名', '活动编号', '服务日期', '认证时长（小时）', '备注', '是否有违纪情况'];
export const cell = (ref, value, type = 'str') => '<x:c r="' + ref + '" t="' + type + '"><x:v>'
  + String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</x:v></x:c>';
export const row = (index, cells) => '<x:row r="' + index + '">' + cells + '</x:row>';

export function asStrict(bytes) {
  const parts = unzipSync(bytes);
  for (const path of Object.keys(parts).filter(path => /\.(xml|rels)$/.test(path))) {
    parts[path] = strToU8(strFromU8(parts[path])
      .replaceAll('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main')
      .replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'));
  }
  return Buffer.from(zipSync(parts));
}

export function workbook(rows = '', names = headers, change = () => {}) {
  const parts = { ...source };
  const header = row(1, names.map((name, i) => cell(String.fromCharCode(65 + i) + '1', name)).join(''));
  parts[sheet] = strToU8(strFromU8(parts[sheet]).replace(/<x:sheetData>.*?<\/x:sheetData>/s,
    () => '<x:sheetData>' + header + rows + '</x:sheetData>'));
  if (names.length === 6) {
    parts['xl/tables/table1.xml'] = strToU8(strFromU8(parts['xl/tables/table1.xml'])
      .replaceAll('A1:G201', 'A1:F201').replace('count="7"', 'count="6"')
      .replace(/<x:tableColumn id="7"[^>]*\/>/, ''));
  }
  change(parts);
  return Buffer.from(zipSync(parts));
}
