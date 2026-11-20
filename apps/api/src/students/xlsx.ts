import { inflateRawSync } from 'node:zlib';

/** 工作簿内容问题：属于用户文件错误，批次应标记 invalid 而不是 failed。 */
export class XlsxContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxContentError';
  }
}

export type CellType = 'text' | 'number' | 'boolean' | 'error' | 'date' | 'formula';

export interface SheetCell {
  /** 从 0 开始的列序号，A=0。 */
  column: number;
  ref: string;
  type: CellType;
  /** 单元格显示文本；公式以等号开头。 */
  text: string;
}

export interface SheetRow {
  number: number;
  cells: SheetCell[];
}

export interface Sheet {
  name: string;
  /** 仅保留至少有一个有值单元格的行，按原工作表行号升序。 */
  rows: SheetRow[];
  truncated: boolean;
}

const maxEntries = 512;
const maxEntryBytes = 32 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;
const maxSheetRows = 5002;

interface ZipEntry {
  method: number;
  compressed: number;
  uncompressed: number;
  local: number;
}

const archive = (buffer: Buffer, cache: Map<string, Buffer>) => ({
  get(name: string) {
    const cached = cache.get(name);
    if (cached) return cached;
    const bytes = readZipEntry(buffer, name);
    cache.set(name, bytes);
    return bytes;
  },
});

function readZipEntry(buffer: Buffer, wanted: string) {
  const entries = zipEntries(buffer);
  const entry = entries.get(wanted);
  if (!entry) throw new XlsxContentError('工作簿缺少必要的部件：' + wanted);
  if (buffer.readUInt32LE(entry.local) !== 0x04034b50)
    throw new XlsxContentError('工作簿压缩目录已损坏');
  const nameLength = buffer.readUInt16LE(entry.local + 26);
  const extraLength = buffer.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) throw new XlsxContentError('工作簿内容被截断');
  if (entry.uncompressed === 0) return Buffer.alloc(0);
  let output: Buffer;
  if (entry.method === 0) output = Buffer.from(data);
  else if (entry.method === 8) {
    try {
      output = inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    } catch {
      throw new XlsxContentError('工作簿压缩数据无法解开');
    }
  } else throw new XlsxContentError('工作簿使用了不支持的压缩方式');
  if (output.length !== entry.uncompressed) throw new XlsxContentError('工作簿部件长度不一致');
  return output;
}

function zipEntries(buffer: Buffer) {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new XlsxContentError('文件不是有效的 .xlsx 工作簿');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count > maxEntries) throw new XlsxContentError('工作簿部件数量超出限制');
  if (offset + count * 46 > buffer.length) throw new XlsxContentError('工作簿目录已损坏');
  const entries = new Map<string, ZipEntry>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new XlsxContentError('工作簿目录已损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff)
      throw new XlsxContentError('不支持 ZIP64 工作簿');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new XlsxContentError('工作簿已加密，无法读取');
    if (name.endsWith('/')) continue;
    total += uncompressed;
    if (uncompressed > maxEntryBytes || total > maxTotalBytes)
      throw new XlsxContentError('工作簿解压后内容过大');
    entries.set(name.replaceAll('\\', '/'), { method, compressed, uncompressed, local });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function xml(buffer: Buffer) {
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function attribute(attributes: string, name: string) {
  const pattern = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"');
  return pattern.exec(attributes)?.[1];
}

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
        );
    }
  });
}

function texts(fragment: string) {
  let value = '';
  const pattern = /<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/g;
  for (const run of fragment.matchAll(pattern)) value += decodeEntities(run[1]);
  return value;
}

function sharedStrings(files: ReturnType<typeof archive>) {
  let source: string;
  try {
    source = xml(files.get('xl/sharedStrings.xml'));
  } catch {
    return [];
  }
  source = source.replace(/<(?:[A-Za-z0-9_]+:)?si\b[^>]*\/>/g, '');
  source = source.replace(/<(?:[A-Za-z0-9_]+:)?rPh\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?rPh>/g, '');
  const values: string[] = [];
  const pattern = /<(?:[A-Za-z0-9_]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?si>/g;
  for (const item of source.matchAll(pattern)) values.push(texts(item[1]));
  return values;
}

interface WorkbookSheet {
  name: string;
  target: string;
}

function workbookSheets(files: ReturnType<typeof archive>): WorkbookSheet[] {
  const book = xml(files.get('xl/workbook.xml'));
  let rels = '';
  try {
    rels = xml(files.get('xl/_rels/workbook.xml.rels'));
  } catch {
    rels = '';
  }
  const targets = new Map<string, string>();
  for (const item of rels.matchAll(/<(?:[A-Za-z0-9_]+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(item[1], 'Id');
    const target = attribute(item[1], 'Target');
    if (id && target) targets.set(id, target);
  }
  const sheets: WorkbookSheet[] = [];
  for (const item of book.matchAll(/<(?:[A-Za-z0-9_]+:)?sheet\b([^>]*?)\/?>/g)) {
    const name = attribute(item[1], 'name');
    const id = attribute(item[1], 'r:id') ?? attribute(item[1], 'id');
    if (!name) continue;
    const target = id ? targets.get(id) : undefined;
    sheets.push({ name, target: resolveTarget(target, sheets.length) });
  }
  return sheets;
}

function resolveTarget(target: string | undefined, index: number) {
  if (!target) return 'xl/worksheets/sheet' + (index + 1) + '.xml';
  const normalized = target.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.startsWith('xl/')) return normalized;
  return 'xl/' + normalized;
}

function cellFrom(cell: string, attributes: string, rowNumber: number, index: number, shared: string[]) {
  const ref = attribute(attributes, 'r') ?? '';
  const column = columnIndex(ref.match(/^[A-Z]+/)?.[0] ?? '') ?? index;
  const type = attribute(attributes, 't');
  const formulaMatch =
    /<(?:[A-Za-z0-9_]+:)?f\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?f>/.exec(cell) ??
    /<(?:[A-Za-z0-9_]+:)?f\b[^>]*\/>/.exec(cell);
  const value = /<(?:[A-Za-z0-9_]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?v>/.exec(cell);
  const inline = /<(?:[A-Za-z0-9_]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?is>/.exec(cell);
  const result: SheetCell = { column, ref: ref || columnName(column) + rowNumber, type: 'text', text: '' };
  if (formulaMatch) {
    const formula = formulaMatch[1] ?? '';
    result.type = 'formula';
    result.text = '=' + decodeEntities(formula);
    return result;
  }
  if (inline) {
    result.text = texts(inline[1]);
    return result;
  }
  if (value === null) return null;
  const raw = decodeEntities(value[1]);
  switch (type) {
    case 's': {
      const entry = shared[Number(raw)];
      if (entry === undefined) throw new XlsxContentError('工作簿共享文本索引无效');
      result.text = entry;
      return result;
    }
    case 'inlineStr':
      result.text = raw;
      return result;
    case 'str':
      result.text = raw;
      return result;
    case 'b':
      result.type = 'boolean';
      result.text = raw === '1' ? 'TRUE' : 'FALSE';
      return result;
    case 'e':
      result.type = 'error';
      result.text = raw;
      return result;
    case 'd':
      result.type = 'date';
      result.text = raw;
      return result;
    default:
      result.type = 'number';
      result.text = raw;
      return result;
  }
}

function columnIndex(letters: string) {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index ? index - 1 : undefined;
}

function columnName(index: number) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** 读取指定名称的工作表；文件结构不合法时抛出 XlsxContentError。 */
export function readXlsxSheet(buffer: Buffer, name: string): Sheet {
  const cache = new Map<string, Buffer>();
  const files = archive(buffer, cache);
  const sheet = workbookSheets(files).find((entry) => entry.name === name);
  if (!sheet) throw new XlsxContentError('工作簿缺少「' + name + '」工作表');
  const source = xml(files.get(sheet.target));
  const shared = sharedStrings(files);
  const rows: SheetRow[] = [];
  let truncated = false;
  const rowPattern = /<(?:[A-Za-z0-9_]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?row>)/g;
  for (const match of source.matchAll(rowPattern)) {
    const attributes = match[1];
    const body = match[2] ?? '';
    const number = Number(attribute(attributes, 'r') ?? rows.length + 1);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const cells: SheetCell[] = [];
    let position = 0;
    for (const cell of body.matchAll(/<(?:[A-Za-z0-9_]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?c>)/g)) {
      const parsed = cellFrom(cell[2] ?? '', cell[1], number, position, shared);
      position = parsed ? parsed.column + 1 : position + 1;
      if (parsed && parsed.text !== '') cells.push(parsed);
    }
    if (!cells.length) continue;
    rows.push({ number, cells });
    if (rows.length > maxSheetRows) {
      truncated = true;
      break;
    }
  }
  return { name, rows, truncated };
}
