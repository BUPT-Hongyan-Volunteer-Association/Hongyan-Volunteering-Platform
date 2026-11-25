import { posix } from 'node:path';
import { buffer as readBuffer } from 'node:stream/consumers';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise, type Entry } from 'yauzl';
import { BusinessError, invalid } from './http.js';

const workbookNamespaces = [
  { spreadsheet: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    documentRels: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' },
  { spreadsheet: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
    documentRels: 'http://purl.oclc.org/ooxml/officeDocument/relationships' },
];
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const reject = (message: string): never => invalid('file', message);

export function attr(tag: SaxesTagNS, key: string) {
  return tag.attributes[key]?.value;
}

export function scan(xml: string, visitor: {
  open?: (tag: SaxesTagNS, parent?: SaxesTagNS) => void;
  close?: (tag: SaxesTagNS) => void;
  text?: (value: string, tag?: SaxesTagNS) => void;
}) {
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  parser.on('doctype', () => reject('工作簿不允许包含 DTD'));
  parser.on('error', () => reject('工作簿 XML 格式错误'));
  parser.on('opentag', (tag) => {
    if (stack.length >= 128) reject('工作簿 XML 嵌套过深');
    visitor.open?.(tag, stack.at(-1));
    stack.push(tag);
  });
  parser.on('closetag', (tag) => { visitor.close?.(tag); stack.pop(); });
  const text = (value: string) => visitor.text?.(value, stack.at(-1));
  parser.on('text', text);
  parser.on('cdata', text);
  parser.write(xml).close();
}

async function openPackage(bytes: Buffer, maxEntries: number, maxEntryBytes: number) {
  const archive = await fromBufferPromise(bytes, { autoClose: false, strictFileNames: true })
    .catch(() => reject('文件不是有效的 xlsx 工作簿'));
  const entries = new Map<string, Entry>();
  try {
    if (archive.entryCount > maxEntries) reject('工作簿部件过多');
    let expanded = 0;
    for await (const entry of archive.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (entry.uncompressedSize > maxEntryBytes || expanded > 64 * 1024 * 1024) reject('工作簿解压体积过大');
      if (entries.has(entry.fileName) || entry.isEncrypted()) reject('工作簿部件重复或已加密');
      if (/(?:^|\/)(?:vbaProject\.bin|macrosheets\/)/i.test(entry.fileName)) reject('不能上传含宏的工作簿');
      entries.set(entry.fileName, entry);
    }
  } catch (error) {
    archive.close();
    if (error instanceof BusinessError) throw error;
    reject('工作簿压缩目录损坏');
  }
  return {
    has: (path: string) => entries.has(path),
    close: () => archive.close(),
    async xml(path: string) {
      const entry = entries.get(path) ?? reject('工作簿缺少必要部件');
      try {
        const data = await readBuffer(await archive.openReadStreamPromise(entry));
        const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
          : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
        return new TextDecoder(encoding, { fatal: true }).decode(data);
      } catch {
        return reject('工作簿部件无法读取');
      }
    },
  };
}

type Package = Awaited<ReturnType<typeof openPackage>>;
async function relationships(pkg: Package, part: string) {
  const directory = posix.dirname(part);
  const path = posix.join(directory, '_rels', posix.basename(part) + '.rels');
  const links = new Map<string, { type: string; target: string }>();
  if (!pkg.has(path)) return links;
  scan(await pkg.xml(path), { open(tag) {
    if (tag.uri !== packageRels || tag.local !== 'Relationship' || attr(tag, 'TargetMode') === 'External') return;
    const id = attr(tag, 'Id'), type = attr(tag, 'Type'), target = attr(tag, 'Target');
    if (!id || !type || !target || links.has(id)) return reject('工作簿关系无效');
    links.set(id, { type, target: posix.resolve('/', directory, target).slice(1) });
  } });
  return links;
}

async function locateWorkbook(pkg: Package) {
  const root = await relationships(pkg, '');
  for (const link of root.values()) {
    const namespaces = workbookNamespaces.find(ns => link.type === ns.documentRels + '/officeDocument');
    if (namespaces) return { book: link.target, ...namespaces };
  }
  return reject('工作簿缺少主文档');
}

export async function readSheetParts(bytes: Buffer, name: string, options: { rejectTotals?: boolean; maxEntries?: number; maxEntryBytes?: number } = {}): Promise<{
  date_system: '1900' | '1904'; sheet: string; spreadsheet: string; shared: string | null;
}> {
  const pkg = await openPackage(bytes, options.maxEntries ?? 4096, options.maxEntryBytes ?? 64 * 1024 * 1024);
  try {
    const { book, documentRels, spreadsheet } = await locateWorkbook(pkg);
    let defaultType: string | undefined, overrideType: string | undefined;
    scan(await pkg.xml('[Content_Types].xml'), { open(tag) {
      if (tag.uri !== contentTypes) return;
      const type = attr(tag, 'ContentType') ?? '';
      if (/macroEnabled|vbaProject|macrosheet/i.test(type)) reject('不能上传含宏的工作簿');
      if (tag.local === 'Default' && attr(tag, 'Extension') === posix.extname(book).slice(1)) defaultType = type;
      if (tag.local === 'Override' && attr(tag, 'PartName') === '/' + book) overrideType = type;
    } });
    if ((overrideType ?? defaultType) !== workbookType) reject('仅接受标准 xlsx 工作簿');
    let sheetId: string | undefined;
    let date_system: '1900' | '1904' = '1900';
    scan(await pkg.xml(book), { open(tag) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'workbookPr' && ['true', '1'].includes(attr(tag, 'date1904') ?? '')) date_system = '1904';
      if (tag.local === 'sheet' && attr(tag, 'name') === name) {
        if (sheetId) reject(name + '工作表重复');
        sheetId = Object.values(tag.attributes).find((value) => value.uri === documentRels && value.local === 'id')?.value;
      }
    } });
    const links = await relationships(pkg, book);
    const sheet = links.get(sheetId ?? '');
    if (!sheet || sheet.type !== documentRels + '/worksheet') return reject('缺少' + name + '工作表');
    if (options.rejectTotals) for (const link of (await relationships(pkg, sheet.target)).values()) {
      if (link.type !== documentRels + '/table') continue;
      scan(await pkg.xml(link.target), { open(tag) {
        if (tag.uri === spreadsheet && tag.local === 'table' && Number(attr(tag, 'totalsRowCount')) > 0) {
          reject(name + '不接受表格合计行：' + (attr(tag, 'ref') ?? ''));
        }
      } });
    }
    const strings = [...links.values()].find((link) => link.type === documentRels + '/sharedStrings');
    return { date_system, spreadsheet, sheet: await pkg.xml(sheet.target), shared: strings ? await pkg.xml(strings.target) : null };
  } finally {
    pkg.close();
  }
}

export type Cell = { type: 'text' | 'number' | 'boolean' | 'date' | 'error'; value: string };
type Raw = Cell | null;

function decodeText(value: string) {
  // Decode each XML text element once so a quoted underscore (_x005F_x000D_) stays literal.
  return value.replace(/_x([\da-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function sharedStrings(xml: string | null, spreadsheet: string) {
  const strings: string[] = [];
  if (!xml) return strings;
  let value = '', run: string | undefined;
  scan(xml, {
    open(tag, parent) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'si') value = '';
      if (tag.local === 't' && (parent?.local === 'si' || parent?.local === 'r')) run = '';
    },
    text(text) { if (run !== undefined) run += text; },
    close(tag) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 't' && run !== undefined) {
        value += decodeText(run);
        run = undefined;
      }
      if (tag.local === 'si') strings.push(value);
    },
  });
  return strings;
}

function decode(type: string, value: string, strings: string[], ref: string,
  report: (at: string, message: string) => null): Raw {
  if (value === '') return null;
  if (type === 's') {
    if (!/^\d+$/.test(value) || strings[Number(value)] === undefined) return report(ref, '共享字符串索引无效');
    value = strings[Number(value)];
    if (!value) return null;
    type = 'str';
  }
  switch (type) {
    case 'inlineStr':
    case 'str':
      if (/[\u0000\uD800-\uDFFF]/u.test(value)) return report(ref, '文本含有无法保存的字符');
      return { type: 'text', value };
    case 'n': return { type: 'number', value };
    case 'b': return { type: 'boolean', value };
    case 'd': return { type: 'date', value };
    case 'e': return { type: 'error', value };
    default: return report(ref, '不支持的单元格类型');
  }
}

export function scanSheet(parts: Awaited<ReturnType<typeof readSheetParts>>, handlers: {
  startRow(number: number): void;
  cell(column: number, ref: string, value: Cell): void;
  /** 识别并保留原公式。未提供时记为错误，同时继续读取缓存值用于逐行预览。 */
  formula?(column: number, ref: string, formula: string): void;
  bad(at: string, message: string): never;
  report(at: string, message: string): null;
  endRow(number: number): void;
}) {
  const { bad } = handlers;
  const { spreadsheet } = parts;
  const strings = sharedStrings(parts.shared, spreadsheet);
  let rowNumber = 0, column = 0;
  let inData = false, inRow = false, run: string | undefined;
  let cell: { ref: string; type: string; value: string; formula?: string } | undefined;
  scan(parts.sheet, {
    open(tag, parent) {
      if (tag.uri !== spreadsheet) return;
      if (tag.local === 'sheetData' && parent?.local === 'worksheet') inData = true;
      if (!inData) return;
      if (tag.local === 'row' && parent?.local === 'sheetData') {
        const next = Number(attr(tag, 'r') ?? rowNumber + 1);
        if (!Number.isInteger(next) || next <= rowNumber || next > 1048576) bad('工作簿', '原表行号无效');
        rowNumber = next;
        handlers.startRow(next);
        column = 0;
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
      if (cell && tag.local === 'f') { cell.formula = ''; run = ''; }
      if (cell && (tag.local === 'v' && parent?.local === 'c' || tag.local === 't' && ['is', 'r'].includes(parent?.local ?? ''))) run = '';
    },
    text(value) { if (run !== undefined) run += value; },
    close(tag) {
      if (tag.uri !== spreadsheet) return;
      if (cell && tag.local === 'f') { cell.formula = run; run = undefined; }
      if (cell && run !== undefined && (tag.local === 'v' || tag.local === 't')) {
        cell.value += tag.local === 't' || cell.type === 'str' ? decodeText(run) : run;
        run = undefined;
      }
      if (tag.local === 'c' && cell) {
        if (cell.formula !== undefined && handlers.formula) handlers.formula(column, cell.ref, cell.formula);
        else {
          if (cell.formula !== undefined) handlers.report(cell.ref, '不接受公式');
          const value = decode(cell.type, cell.value, strings, cell.ref, handlers.report);
          if (value) handlers.cell(column, cell.ref, value);
        }
        cell = undefined;
      }
      if (tag.local === 'row' && inRow) {
        inRow = false;
        handlers.endRow(rowNumber);
      }
      if (tag.local === 'sheetData') inData = false;
    },
  });
}
