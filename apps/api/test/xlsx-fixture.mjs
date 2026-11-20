// 测试用最小 XLSX 生成器：按模板的命名空间前缀、表格范围与共享文本形态生成工作簿。
import { deflateRawSync } from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const compressed = file.compress ? deflateRawSync(data) : data;
    const method = file.compress ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export const importHeaders = ['学号', '姓名', '级部', '年级', '班级', '学院'];

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
        '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
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
  return zip(files.map((file) => ({ ...file, compress })));
}

/** 生成“学生建档”工作表：rows 为 {number, values:[学号,姓名,级部,年级,班级,学院], extra?:Record<string,any>}；includeCollege=false 时生成五列旧版表头；columnOrder 可自定义列顺序。 */
export function rosterSheet(rows, options = {}) {
  const headers =
    options.columnOrder ??
    (options.includeCollege === false ? importHeaders.slice(0, 5) : importHeaders);
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