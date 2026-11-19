import { posix } from 'node:path';
import { buffer as readBuffer } from 'node:stream/consumers';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise, type Entry } from 'yauzl';
import { BusinessError, invalid } from '../http.js';

export const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const documentRels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
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

async function openPackage(bytes: Buffer) {
  const archive = await fromBufferPromise(bytes, { autoClose: false, strictFileNames: true })
    .catch(() => reject('文件不是有效的 xlsx 工作簿'));
  const entries = new Map<string, Entry>();
  try {
    if (archive.entryCount > 4096) reject('工作簿部件过多');
    let expanded = 0;
    for await (const entry of archive.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (expanded > 64 * 1024 * 1024) reject('工作簿解压体积过大');
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

export async function readHourParts(bytes: Buffer): Promise<{
  date_system: '1900' | '1904'; sheet: string; shared: string | null;
}> {
  const pkg = await openPackage(bytes);
  try {
    const root = await relationships(pkg, '');
    const book = [...root.values()].find((link) => link.type === documentRels + '/officeDocument')?.target
      ?? reject('工作簿缺少主文档');
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
      if (tag.local === 'sheet' && attr(tag, 'name') === '时长录入') {
        if (sheetId) reject('时长录入工作表重复');
        sheetId = Object.values(tag.attributes).find((value) => value.uri === documentRels && value.local === 'id')?.value;
      }
    } });
    const links = await relationships(pkg, book);
    const sheet = links.get(sheetId ?? '');
    if (!sheet || sheet.type !== documentRels + '/worksheet') return reject('缺少时长录入工作表');
    for (const link of (await relationships(pkg, sheet.target)).values()) {
      if (link.type !== documentRels + '/table') continue;
      scan(await pkg.xml(link.target), { open(tag) {
        if (tag.uri === spreadsheet && tag.local === 'table' && (Number(attr(tag, 'totalsRowCount')) > 0
          || ['true', '1'].includes(attr(tag, 'totalsRowShown') ?? ''))) {
          reject('时长录入不接受表格合计行：' + (attr(tag, 'ref') ?? ''));
        }
      } });
    }
    const strings = [...links.values()].find((link) => link.type === documentRels + '/sharedStrings');
    return { date_system, sheet: await pkg.xml(sheet.target), shared: strings ? await pkg.xml(strings.target) : null };
  } finally {
    pkg.close();
  }
}
