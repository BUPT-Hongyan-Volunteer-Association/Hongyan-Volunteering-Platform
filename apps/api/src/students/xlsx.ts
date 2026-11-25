import { invalid } from '../http.js';
import { readSheetParts, scanSheet } from '../ooxml.js';

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

export async function readXlsxSheet(bytes: Buffer, name: string, headerOnly = false): Promise<Sheet> {
  const parts = await readSheetParts(bytes, name, { maxEntries: 512, maxEntryBytes: 32 * 1024 * 1024 });
  const rows: SheetRow[] = [];
  let cells: SheetCell[] = [], truncated = false;
  const done = Symbol('sheet complete');
  try {
    scanSheet(parts, {
      startRow() { cells = []; },
      cell(column, ref, value) {
        const text = value.type === 'boolean' ? (value.value === '1' ? 'TRUE' : 'FALSE') : value.value;
        cells.push({ column: column - 1, ref, type: value.type, text });
      },
      formula(column, ref, formula) { cells.push({ column: column - 1, ref, type: 'formula', text: '=' + formula }); },
      bad: invalid,
      report(at, message) { return invalid(at, message); },
      endRow(number) {
        if (cells.length) rows.push({ number, cells });
        if (rows.length > 5002) truncated = true;
        if (headerOnly || truncated) throw done;
      },
    });
  } catch (error) { if (error !== done) throw error; }
  return { name, rows, truncated };
}
