import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { errorWorkbook } from '../dist/hours/error-report.js';
import { readXlsxSheet } from '../dist/students/xlsx.js';
import { parseHourWorkbook } from '../dist/hours/workbook.js';
import { asStrict, cell, headers, row, sheet, template, workbook } from './hour-workbook-fixture.mjs';

const parse = (buffer) => parseHourWorkbook('合成.xlsx', buffer);

test('错误报告按文本长度截断，保留 XML 转义字符', () => {
  const expected = '甲'.repeat(32766) + '&';
  const file = errorWorkbook([{ field: '备注', message: expected + '乙' }]);
  const cells = readXlsxSheet(Buffer.from(file), '校验错误').rows[1].cells;
  assert.equal(cells.find((cell) => cell.column === 2).text, expected);
});

test('实际空白模板只解析时长录入，样式行不计数', async () => {
  const result = await parse(template);
  assert.equal(result.template_structure, 'hours_misconduct_7');
  assert.equal(result.date_system, '1900');
  assert.deepEqual(result.rows, []);
});

test('旧六列补未提供，七列缺值仍为缺值；保留稀疏原行和原值', async () => {
  const data = row(202, cell('A202', '0000000001') + cell('D202', '45000', 'n') + cell('E202', '1.2500000000000001', 'n') + '<x:c r="Z202" s="1"/>')
    + row(804, cell('E804', '1.2'));
  const result = await parse(workbook(data, headers.slice(0, 6), (parts) => {
    parts['xl/workbook.xml'] = strToU8(strFromU8(parts['xl/workbook.xml']).replace('<x:sheets>', '<x:workbookPr date1904="1"/><x:sheets>'));
  }));
  assert.equal(result.template_structure, 'legacy_hours_6');
  assert.equal(result.date_system, '1904');
  assert.deepEqual(result.rows.map((record) => record.row_number), [202, 804]);
  const [first, second] = result.rows;
  assert.deepEqual(first.student_no, { type: 'text', value: '0000000001' });
  assert.deepEqual(first.service_date, { type: 'number', value: '45000' });
  assert.deepEqual(first.credited_hours, { type: 'number', value: '1.2500000000000001' });
  assert.deepEqual(second.credited_hours, { type: 'text', value: '1.2' });
  assert.equal(first.misconduct_reported, 'not_provided');
  assert.equal((await parse(workbook(data))).rows[0].misconduct_reported, null);
});

test('共享、内联与直接文本还原 Excel 转义，富文本按段拼接', async () => {
  const note = '迟到_x000D_\n已补签';
  const rich = '<x:c r="F2" t="inlineStr"><x:is><x:r><x:t>迟到_x000D_</x:t></x:r><x:r><x:t>\n已补签</x:t></x:r></x:is></x:c>';
  const data = row(2, cell('A2', '1', 'n') + cell('B2', '_x005F_x000D_与_xZZZZ_') + rich + cell('G2', '有'))
    + row(3, cell('F3', '0', 's')) + row(4, cell('F4', note));
  const bytes = workbook(data, headers, (parts) => {
    parts['xl/sharedStrings.xml'] = strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>' + note + '</t></si></sst>');
  });
  const result = await parse(bytes);
  assert.deepEqual(await parse(asStrict(bytes)), result);
  const [record] = result.rows;
  assert.deepEqual(record.student_no, { type: 'number', value: '1' });
  assert.equal(record.student_name.value, '_x000D_与_xZZZZ_');
  for (const { remark } of result.rows) assert.equal(remark.value, '迟到\r\n已补签');
  assert.equal(record.misconduct_reported.value, '有');
});

test('从工作簿关系定位目标页，不假定文件名或第一页', async () => {
  const result = await parse(workbook(row(34, cell('A34', '0000000007')), headers, (parts) => {
    parts['xl/worksheets/hours.xml'] = parts[sheet];
    delete parts[sheet];
    for (const name of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
      parts[name] = strToU8(strFromU8(parts[name]).replace('/xl/worksheets/sheet1.xml', '/xl/worksheets/hours.xml'));
    }
    parts['xl/worksheets/_rels/hours.xml.rels'] = parts['xl/worksheets/_rels/sheet1.xml.rels'];
    delete parts['xl/worksheets/_rels/sheet1.xml.rels'];
    parts['xl/workbook.xml'] = strToU8(strFromU8(parts['xl/workbook.xml'])
      .replace(/(<x:sheet name="时长录入"[^>]*\/>)(<x:sheet name="填写说明"[^>]*\/>)/, '$2$1'));
  }));
  assert.deepEqual(result.rows.map((record) => [record.row_number, record.student_no.value]), [[34, '0000000007']]);
});

test('错误表头和带合计行的表结构拒绝整表', async () => {
  for (const names of [[...headers.slice(0, 6), '认定依据'], headers.toReversed(), headers.slice(0, 5), [...headers, '多余列']]) {
    await assert.rejects(parse(workbook('', names)), /表头|未知列/);
  }
  const afterShowingTotals = count => workbook(row(2, cell('E2', '4', 'n')), headers, parts => {
    const table = 'xl/tables/table1.xml';
    parts[table] = strToU8(strFromU8(parts[table]).replace('totalsRowShown="0"', 'totalsRowShown="1"')
      .replace('totalsRowCount="0"', 'totalsRowCount="' + count + '"'));
  });
  await assert.rejects(parse(afterShowingTotals(1)), /合计/);
  await assert.rejects(parse(asStrict(afterShowingTotals(1))), /合计/);
  assert.equal((await parse(afterShowingTotals(0))).rows[0].credited_hours.value, '4');
});

test('一次报告所有可继续扫描的单元格错误，保留实际行号和列', async () => {
  const data = row(202, cell('H202','多余') + cell('I202','多余'))
    + row(803, '<x:c r="E803"><x:f>1+1</x:f><x:v>2</x:v></x:c>')
    + row(804, cell('E804','1.25','n') + cell('H804','多余') + '<x:c r="I804" s="1"/>')
    + row(805, cell('A805', '合计')) + row(806, cell('F806', '说明_x0000_'));
  const { rows } = await parse(workbook(data));
  assert.deepEqual(rows.map(row => row.errors.map(issue => [issue.row, issue.field, issue.message])), [
    [[202, 'H202', '未知列存在数据'], [202, 'I202', '未知列存在数据']],
    [[803, 'E803', '不接受公式']], [[804, 'H804', '未知列存在数据']], [[805, '第 805 行', '不接受合计行']],
    [[806, 'F806', '文本含有无法保存的字符']],
  ]);
  assert.deepEqual(rows[2].credited_hours, { type: 'number', value: '1.25' });
  const legacy = await parse(workbook(row(888, cell('G888','有')), headers.slice(0,6)));
  assert.equal(legacy.rows[0].errors[0].field, 'G888');
});

test('无效文件、宏、缺失目标页均拒收', async () => {
  await assert.rejects(parseHourWorkbook('伪装.xlsm', template), /xlsx/);
  await assert.rejects(parse(Buffer.from('不是工作簿')), /工作簿/);
  await assert.rejects(parse(workbook('', headers, (parts) => { parts['xl/vbaProject.bin'] = new Uint8Array(1); })), /宏/);
  await assert.rejects(parse(workbook('', headers, (parts) => {
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('sheet.main+xml','macroEnabled.main+xml'));
  })), /宏/);
  await assert.rejects(parse(workbook('', headers, (parts) => {
    parts['xl/workbook.xml'] = strToU8(strFromU8(parts['xl/workbook.xml']).replace('时长录入','其他'));
  })), /时长录入/);
});

test('去重前 5000 条可读，5001 条拒绝；不止读 200 条', async () => {
  const data = Array.from({ length: 5000 }, (_, offset) => row(offset+2, cell('A'+(offset+2),'0000000001'))).join('');
  const result = await parse(workbook(data));
  assert.equal(result.rows.length, 5000);
  assert.equal(result.rows[200].row_number, 202);
  await assert.rejects(parse(workbook(data + row(5002,cell('A5002','0000000001')))), /5000/);
});

test('文件按字节检查，包含恰好 5 MiB 的有效包', async () => {
  const parts = { ...unzipSync(template), 'padding.bin': new Uint8Array(0) };
  const limit = 5242880;
  parts['padding.bin'] = new Uint8Array(limit - zipSync(parts, {level:0}).length);
  const buffer = Buffer.from(zipSync(parts, {level:0}));
  assert.equal(buffer.length, limit);
  assert.equal((await parse(buffer)).rows.length, 0);
  await assert.rejects(parse(Buffer.concat([buffer, Buffer.alloc(1)])), /5 MB/);
});
