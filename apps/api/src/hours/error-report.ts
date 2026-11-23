import type { FieldError } from '@hongyan/contracts/types';
import { exportWorkbook } from '../workbook.js';

export function errorWorkbook(errors: FieldError[]) {
  return exportWorkbook({
    name: '校验错误',
    headers: ['原表行号', '字段', '错误原因'],
    widths: [20, 20, 64],
    rows: errors.map((error) => [
      String(error.row ?? ''),
      error.field ?? 'file',
      error.message,
    ]),
  });
}
