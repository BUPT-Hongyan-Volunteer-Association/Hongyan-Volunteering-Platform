import { localDate } from '../activityDisplay';

export const units = { week: '周', month: '月' } as const;
export type TimeUnit = keyof typeof units;
export const validUnit = (v: unknown): v is TimeUnit =>
  typeof v === 'string' && Object.hasOwn(units, v);
export const validDate = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().startsWith(v + 'T');

const day = 86400000;
export function dateWindow(date: string, unit: TimeUnit | 'day') {
  const calendar = new Date(date + 'T00:00:00Z');
  let start = Date.parse(date + 'T00:00:00+08:00');
  if (unit === 'week') start -= ((calendar.getUTCDay() + 6) % 7) * day;
  if (unit === 'month') {
    start -= (calendar.getUTCDate() - 1) * day;
    const daysInMonth = new Date(
      Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return { start, end: start + daysInMonth * day };
  }
  return { start, end: start + (unit === 'week' ? 7 : 1) * day };
}
export function shiftDate(date: string, unit: TimeUnit, direction: number) {
  const { start, end } = dateWindow(date, unit);
  if (unit === 'month') {
    const first = new Date(localDate(start) + 'T00:00:00Z');
    first.setUTCMonth(first.getUTCMonth() + direction);
    return first.toISOString().slice(0, 10);
  }
  return localDate(start + (end - start) * direction);
}
export function windowLabel(start: number, end: number, unit: TimeUnit) {
  const shortDate = (t: number) =>
    new Date(t).toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
    });
  if (unit === 'month') return localDate(start).slice(0, 7).replace('-', ' 年 ') + ' 月';
  const year = localDate(start).slice(0, 4) + ' 年 ';
  return year + shortDate(start) + ' – ' + shortDate(end - 1);
}
