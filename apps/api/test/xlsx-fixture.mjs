// 测试用最小 XLSX 生成器：按模板的命名空间前缀、表格范围与共享文本形态生成工作簿。
import { zipSync, strToU8 } from 'fflate';

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export const importHeaders = ['学号', '姓名', '年级', '班级', '学院'];

/**
 * @param {object} options
 * @param {Array<{name?: string, rows: Array<{number: number, cells: Record<string, any>}>, dimension?: string, tableRef?: string, tableName?: string}>} options.sheets
 * @param {boolean} [options.prefix] 是否使用 x: 命名空间前缀（模板使用）
 * @param {boolean} [options.sharedStrings] 文本是否写入共享文本表
 * @param {boolean} [options.compress] 是否 deflate 压缩
 */
export function buildWorkbook({ sheets, prefix = true, sharedStrings = false, compress = true }) {
  const p = prefix ? 'x:' : '';
  const ns = (defaultNamespace) =>
    prefix ? ' xmlns:x="' + defaultNamespace + '"' : ' xmlns="' + defaultNamespace + '"';
  const shared = [];
  const sharedIndex = new Map();
  const addShared = (value) => {
    if (!sharedIndex.has(value)) {
      sharedIndex.set(value, shared.length);
      shared.push(value);
    }
    return sharedIndex.get(value);
  };
  const cell = (ref, spec) => {
    if (spec === undefined || spec === null) return '';
    const open = '<' + p + 'c r="' + ref + '"';
    if (typeof spec === 'string') {
      if (sharedStrings) return open + ' t="s"><' + p + 'v>' + addShared(spec) + '</' + p + 'v></' + p + 'c>';
      return open + ' t="str"><' + p + 'v>' + escape(spec) + '</' + p + 'v></' + p + 'c>';
    }
    if (spec.blank) return open + '/>';
    if (spec.n !== undefined) return open + '><' + p + 'v>' + escape(spec.n) + '</' + p + 'v></' + p + 'c>';
    if (spec.f !== undefined)
      return (
        open +
        '><' +
        p +
        'f>' +
        escape(spec.f) +
        '</' +
        p +
        'f>' +
        (spec.v !== undefined ? '<' + p + 'v>' + escape(spec.v) + '</' + p + 'v>' : '') +
        '</' +
        p +
        'c>'
      );
    if (spec.inline !== undefined)
      return (
        open + ' t="inlineStr"><' + p + 'is><' + p + 't>' + escape(spec.inline) + '</' + p + 't></' + p + 'is></' + p + 'c>'
      );
    if (spec.bool !== undefined)
      return open + ' t="b"><' + p + 'v>' + (spec.bool ? 1 : 0) + '</' + p + 'v></' + p + 'c>';
    if (spec.error !== undefined)
      return open + ' t="e"><' + p + 'v>' + escape(spec.error) + '</' + p + 'v></' + p + 'c>';
    throw new Error('不支持的测试单元格：' + JSON.stringify(spec));
  };
  const sheetXml = (sheet) => {
    if (sheet.xml !== undefined) return sheet.xml;
    const rows = sheet.rows
      .map(
        (row) =>
          '<' +
          p +
          'row r="' +
          row.number +
          '">' +
          Object.entries(row.cells)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([column, spec]) => cell(column + row.number, spec))
            .join('') +
          '</' +
          p +
          'row>',
      )
      .join('');
    return (
      '<?xml version="1.0" encoding="utf-8"?><' +
      p +
      'worksheet' +
      ns('http://schemas.openxmlformats.org/spreadsheetml/2006/main') +
      (prefix ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '') +
      '>' +
      (sheet.dimension ? '<' + p + 'dimension ref="' + sheet.dimension + '"/>' : '') +
      '<' + p + 'sheetData>' + rows + '</' + p + 'sheetData>' +
      (sheet.tableRef
        ? '<' + p + 'tableParts count="1"><' + p + 'tablePart r:id="rId1"/></' + p + 'tableParts>'
        : '') +
      '</' + p + 'worksheet>'
    );
  };
  const tableXml = (ref, name) =>
    '<?xml version="1.0" encoding="utf-8"?><' +
    p +
    'table' + ns('http://schemas.openxmlformats.org/spreadsheetml/2006/main') + ' id="1" name="' +
    name +
    '" displayName="' + name + '" ref="' + ref + '" headerRowCount="1" totalsRowCount="0">' +
    '<' + p + 'tableColumns count="5">' +
    importHeaders.map((header, index) => '<' + p + 'tableColumn id="' + (index + 1) + '" name="' + header + '"/>').join('') +
    '</' + p + 'tableColumns></' + p + 'table>';
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="utf-8"?><' +
        p +
        'workbook' +
        ns('http://schemas.openxmlformats.org/spreadsheetml/2006/main') +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><' +
        p +
        'sheets>' +
        sheets
          .map(
            (sheet, index) =>
              '<' + p + 'sheet name="' + escape(sheet.name ?? '学生建档') + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>',
          )
          .join('') +
        '</' + p + 'sheets></' + p + 'workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_sheet, index) =>
              '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>',
          )
          .join('') +
        (sharedStrings ? '<Relationship Id="shared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : '') +
        '</Relationships>',
    },
    ...sheets.map((sheet, index) => ({
      name: 'xl/worksheets/sheet' + (index + 1) + '.xml',
      data: sheetXml(sheet),
    })),
    ...sheets.flatMap((sheet, index) =>
      sheet.tableRef
        ? [
            {
              name: 'xl/worksheets/_rels/sheet' + (index + 1) + '.xml.rels',
              data:
                '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table' + (index + 1) + '.xml"/></Relationships>',
            },
            {
              name: 'xl/tables/table' + (index + 1) + '.xml',
              data: tableXml(sheet.tableRef, sheet.tableName ?? 'StudentRosterInput'),
            },
          ]
        : [],
    ),
  ];
  if (sharedStrings)
    files.push({
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0" encoding="utf-8"?><' +
        p +
        'sst' + ns('http://schemas.openxmlformats.org/spreadsheetml/2006/main') + ' count="' +
        shared.length +
        '" uniqueCount="' +
        shared.length +
        '">' +
        shared.map((value) => '<' + p + 'si><' + p + 't>' + escape(value) + '</' + p + 't></' + p + 'si>').join('') +
        '</' + p + 'sst>',
    });
  const entries = Object.fromEntries(files.map(({ name, data }) => [
    name, typeof data === 'string' ? strToU8(data) : data,
  ]));
  return Buffer.from(zipSync(entries, { level: compress ? 6 : 0 }));
}

export function rosterSheet(rows, options = {}) {
  const headers = options.columnOrder ?? (options.includeCollege === false ? importHeaders.slice(0, 4) : importHeaders);
  const valueIndex = new Map(importHeaders.map((label, index) => [label, index]));
  const header = {
    number: 1,
    cells: Object.fromEntries(headers.map((headerText, index) => [String.fromCharCode(65 + index), headerText])),
  };
  return {
    name: options.name ?? '学生建档',
    dimension: options.dimension,
    tableRef: options.tableRef,
    rows: [
      header,
      ...rows.map((row) => ({
        number: row.number,
        cells: {
          ...Object.fromEntries(
            headers.flatMap((header, index) => {
              const value = row.values[valueIndex.get(header)];
              return value === undefined || value === null
                ? []
                : [[String.fromCharCode(65 + index), value]];
            }),
          ),
          ...row.extra,
        },
      })),
    ],
  };
}