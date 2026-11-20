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
  if (entry.local + 30 > buffer.length || buffer.readUInt32LE(entry.local) !== 0x04034b50)
    throw new XlsxContentError('工作簿压缩目录已损坏');
  const nameLength = buffer.readUInt16LE(entry.local + 26);
  const extraLength = buffer.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressed);
  if (start > buffer.length || data.length !== entry.compressed)
    throw new XlsxContentError('工作簿内容被截断');
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
    if (offset + 46 + nameLength > buffer.length) throw new XlsxContentError('工作簿目录已损坏');
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

const attributePatterns = new Map<string, RegExp>();
function attribute(attributes: string, name: string) {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"');
    attributePatterns.set(name, pattern);
  }
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
      default: {
        const codePoint = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          throw new XlsxContentError('工作簿文本包含无效字符编码');
        }
      }
    }
  });
}

const tagPattern = /^(?:[A-Za-z0-9_]+:)?([A-Za-z0-9_]+)/;

interface Element {
  attributes: string;
  body: string;
  end: number;
}

function malformed(): never {
  throw new XlsxContentError('工作簿 XML 结构不完整');
}

/** 跳过一个注释或处理指令，返回其后的位置；不是这类标记时返回 -1。 */
function skipMarkup(source: string, start: number) {
  if (source.startsWith('<!--', start)) {
    const end = source.indexOf('-->', start + 4);
    if (end < 0) malformed();
    return end + 3;
  }
  if (source.startsWith('<?', start)) {
    const end = source.indexOf('?>', start + 2);
    if (end < 0) malformed();
    return end + 2;
  }
  if (source.startsWith('<![CDATA[', start)) {
    const end = source.indexOf(']]>', start + 9);
    if (end < 0) malformed();
    return end + 3;
  }
  return -1;
}

/**
 * 线性扫描指定闭合标签。游标只向后移动，不对同一段内容反复回溯，
 * 因此畸形 XML（大量未闭合标签）也不会退化为二次复杂度。
 */
function closingTag(source: string, from: number, name: string) {
  let cursor = from;
  while (true) {
    const start = source.indexOf('</', cursor);
    if (start < 0) return null;
    const match = tagPattern.exec(source.slice(start + 2, start + 42));
    if (!match) {
      cursor = start + 2;
      continue;
    }
    const end = source.indexOf('>', start);
    if (end < 0) return null;
    if (match[1] === name) return { start, end: end + 1 };
    cursor = end + 1;
  }
}

/** 线性查找下一个指定元素（跳过注释、处理指令与其他标签）。 */
function nextElement(source: string, from: number, name: string): Element | null {
  let cursor = from;
  while (true) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return null;
    const skipped = skipMarkup(source, start);
    if (skipped >= 0) {
      cursor = skipped;
      continue;
    }
    const match = tagPattern.exec(source.slice(start + 1, start + 41));
    if (!match || match[1] !== name) {
      cursor = start + 1;
      continue;
    }
    const end = source.indexOf('>', start);
    if (end < 0) malformed();
    const selfClosing = source[end - 1] === '/';
    const attributes = source.slice(start + 1 + match[0].length, selfClosing ? end - 1 : end);
    if (selfClosing) return { attributes, body: '', end: end + 1 };
    const close = closingTag(source, end + 1, name);
    if (!close) malformed();
    return { attributes, body: source.slice(end + 1, close.start), end: close.end };
  }
}

function texts(fragment: string) {
  let value = '';
  let cursor = 0;
  let element = nextElement(fragment, cursor, 't');
  while (element) {
    value += decodeEntities(element.body);
    cursor = element.end;
    element = nextElement(fragment, cursor, 't');
  }
  return value;
}

/** 共享文本条目：拼接全部 <t> 文本，跳过注音 <rPh> 块。 */
function sharedStringText(source: string) {
  let value = '';
  let cursor = 0;
  while (true) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return value;
    const skipped = skipMarkup(source, start);
    if (skipped >= 0) {
      cursor = skipped;
      continue;
    }
    const match = tagPattern.exec(source.slice(start + 1, start + 41));
    if (!match) {
      cursor = start + 1;
      continue;
    }
    if (match[1] === 'rPh') {
      const element = nextElement(source, start, 'rPh');
      if (!element) return value;
      cursor = element.end;
      continue;
    }
    if (match[1] === 't') {
      const element = nextElement(source, start, 't');
      if (!element) return value;
      value += decodeEntities(element.body);
      cursor = element.end;
      continue;
    }
    cursor = start + 1;
  }
}

function sharedStrings(files: ReturnType<typeof archive>) {
  let source: string;
  try {
    source = xml(files.get('xl/sharedStrings.xml'));
  } catch {
    // 共享文本是可选部件；没有它时单元格应使用内联文本或公式结果。
    return [];
  }
  const values: string[] = [];
  let cursor = 0;
  let item = nextElement(source, cursor, 'si');
  while (item) {
    values.push(sharedStringText(item.body));
    cursor = item.end;
    item = nextElement(source, cursor, 'si');
  }
  return values;
}

interface WorkbookSheet {
  name: string;
  target: string;
}

function workbookSheets(files: ReturnType<typeof archive>): WorkbookSheet[] {
  const book = xml(files.get('xl/workbook.xml'));
  const rels = xml(files.get('xl/_rels/workbook.xml.rels'));
  const targets = new Map<string, string>();
  let cursor = 0;
  let relationship = nextElement(rels, cursor, 'Relationship');
  while (relationship) {
    const id = attribute(relationship.attributes, 'Id');
    const target = attribute(relationship.attributes, 'Target');
    if (id && target) targets.set(id, target);
    cursor = relationship.end;
    relationship = nextElement(rels, cursor, 'Relationship');
  }
  const sheets: WorkbookSheet[] = [];
  cursor = 0;
  let sheet = nextElement(book, cursor, 'sheet');
  while (sheet) {
    const name = attribute(sheet.attributes, 'name');
    const relation = attribute(sheet.attributes, 'r:id');
    const target = relation ? targets.get(relation) : undefined;
    if (!name || !target) throw new XlsxContentError('工作簿工作表缺少名称或关系目标');
    sheets.push({ name, target: resolveTarget(target) });
    cursor = sheet.end;
    sheet = nextElement(book, cursor, 'sheet');
  }
  return sheets;
}

function resolveTarget(target: string) {
  const normalized = target.replaceAll('\\', '/').replace(/^\/+/, '');
  return normalized.startsWith('xl/') ? normalized : 'xl/' + normalized;
}

function cellFrom(body: string, attributes: string, shared: string[]): SheetCell {
  const ref = attribute(attributes, 'r');
  if (!ref) malformed();
  const column = columnIndex(ref.match(/^[A-Z]+/)?.[0] ?? '');
  if (column === undefined) malformed();
  const type = attribute(attributes, 't');
  const formula = nextElement(body, 0, 'f');
  if (formula) return { column, ref, type: 'formula', text: '=' + decodeEntities(formula.body) };
  const inline = nextElement(body, 0, 'is');
  if (inline) return { column, ref, type: 'text', text: texts(inline.body) };
  const value = nextElement(body, 0, 'v');
  if (!value) return { column, ref, type: 'text', text: '' };
  const raw = decodeEntities(value.body);
  const cell: SheetCell = { column, ref, type: 'text', text: raw };
  switch (type) {
    case 's': {
      const entry = shared[Number(raw)];
      if (entry === undefined) throw new XlsxContentError('工作簿共享文本索引无效');
      cell.text = entry;
      return cell;
    }
    case 'inlineStr':
      return cell;
    case 'str':
      return cell;
    case 'b':
      cell.type = 'boolean';
      cell.text = raw === '1' ? 'TRUE' : 'FALSE';
      return cell;
    case 'e':
      cell.type = 'error';
      return cell;
    case 'd':
      cell.type = 'date';
      return cell;
    default:
      cell.type = 'number';
      return cell;
  }
}

function columnIndex(letters: string) {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index ? index - 1 : undefined;
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
  let cursor = 0;
  let row = nextElement(source, cursor, 'row');
  while (row) {
    const number = Number(attribute(row.attributes, 'r'));
    if (!Number.isSafeInteger(number) || number < 1) malformed();
    const cells: SheetCell[] = [];
    let cellCursor = 0;
    let cell = nextElement(row.body, cellCursor, 'c');
    while (cell) {
      const parsed = cellFrom(cell.body, cell.attributes, shared);
      if (parsed.text !== '') cells.push(parsed);
      cellCursor = cell.end;
      cell = nextElement(row.body, cellCursor, 'c');
    }
    if (cells.length) {
      rows.push({ number, cells });
      if (rows.length > maxSheetRows) {
        truncated = true;
        break;
      }
    }
    cursor = row.end;
    row = nextElement(source, cursor, 'row');
  }
  return { name, rows, truncated };
}
