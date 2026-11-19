import type { ActivitySchedule } from '@hongyan/contracts/types';
import { slots } from '../activities/schedule.js';
import type { HourInputRow } from './workbook.js';

type Raw = HourInputRow['service_date'];
const dayMs = 86400000;

function scaledInteger(raw: Raw, scale: number, maxDigits: number) {
  if (raw?.type !== 'number') return null;
  const parts = /^\+?(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw.value);
  if (!parts || (!parts[1] && !parts[2])) return null;
  const fraction = parts[2] ?? '';
  const digits = (parts[1] + fraction).replace(/^0+/, '');
  if (!digits) return 0;
  let length = digits.length;
  while (digits[length - 1] === '0') length--;
  const significant = digits.slice(0, length);
  const zeros = Number(parts[3] ?? 0) + scale - fraction.length + digits.length - significant.length;
  if (zeros < 0 || significant.length + zeros > maxDigits) return null;
  return Number(significant) * 10 ** zeros;
}

export function hourTenths(raw: Raw) {
  const value = scaledInteger(raw, 1, 4);
  return value && value <= 9999 ? value : null;
}
export const hours = (tenths: number) => (tenths / 10).toFixed(1);
export const normalizeFact = (value: string) => value.replace(/\r\n?/g, '\n').trim();
export const beijingDay = (now: Date) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);

export function serviceDate(raw: Raw, system: '1900' | '1904'): string | null {
  if (raw?.type === 'number') {
    const serial = scaledInteger(raw, 0, 7);
    if (serial === null || (system === '1900' && (serial === 0 || serial === 60))) return null;
    const base = Date.parse(system === '1904' ? '1904-01-01' : '1899-12-31');
    const date = new Date(base + (serial - Number(system === '1900' && serial > 60)) * dayMs);
    return date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : null;
  }
  if (raw?.type !== 'text' && raw?.type !== 'date') return null;
  const value = raw.type === 'date' ? raw.value.replace(/T00:00:00(?:\.0+)?Z?$/, '') : raw.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
  const millis = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(millis) && new Date(millis).toISOString().startsWith(value + 'T') ? value : null;
}

export function scheduleCoverage(revisions: readonly { revision: number; schedule: ActivitySchedule }[]) {
  const byRevision = new Map(revisions.map(({ revision, schedule }) => [revision, slots(schedule)]));
  const cache = new Map<string, number>();
  return (revision: number | null, day: string) => {
    const key = revision + '/' + day;
    if (!cache.has(key)) {
      const start = Date.parse(day + 'T00:00:00+08:00');
      const duration = (byRevision.get(revision ?? -1) ?? []).reduce((sum, slot) => sum + Math.max(0,
        Math.min(start + dayMs, Date.parse(slot.ends_at)) - Math.max(start, Date.parse(slot.starts_at))), 0);
      cache.set(key, duration);
    }
    return cache.get(key)!;
  };
}
