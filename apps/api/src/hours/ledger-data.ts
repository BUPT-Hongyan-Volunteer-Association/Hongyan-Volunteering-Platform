import type { ActivitySchedule, HourMisconductReview, HourWarning } from '@hongyan/contracts/types';
import type { Tx } from '../activities/workflow.js';
import { BusinessError } from '../http.js';
import { hourWarnings } from './warnings.js';
import { hourTenths, scheduleCoverage } from './values.js';

export interface StudentDay {
  student_id: string;
  service_date: string;
}
export interface LedgerKey extends StudentDay {
  activity_id: string;
}
export const dayKey = ({ student_id, service_date }: StudentDay) => student_id + '/' + service_date;
export const recordKey = (row: LedgerKey) => dayKey(row) + '/' + row.activity_id;
export const factKey = (row: LedgerKey, fact: string) => recordKey(row) + '/' + fact;
export const dateText = (value: Date) => value.toISOString().slice(0, 10);
export const tenths = (value: string) => hourTenths({ type: 'number', value })!;
export function versionConflict(message = '账务或获批安排已变化，请刷新后复核'): never {
  throw new BusinessError(409, 'version_conflict', message);
}

export function distinctDays(rows: readonly StudentDay[]) {
  return [...new Map(rows.map(({ student_id, service_date }) =>
    [dayKey({ student_id, service_date }), { student_id, service_date }])).values()];
}

export async function lockLedger(tx: Tx, rows: readonly LedgerKey[]) {
  // 每笔写入先锁跨活动累计，再锁记录键。整组始终按相同顺序取锁。
  // 固定键行也覆盖尚未入账的记录，5000 行无需为每个键占一个 advisory lock。
  for (const keys of [
    rows.map((row) => 'hours/day/' + dayKey(row)),
    rows.map((row) => 'hours/record/' + recordKey(row)),
  ]) {
    if (!keys.length) continue;
    await tx.$executeRaw`
      INSERT INTO hour_ledger_lock (key)
      SELECT DISTINCT key FROM unnest(${keys}::text[]) AS input(key) ORDER BY key
      ON CONFLICT DO NOTHING`;
    await tx.$executeRaw`
      SELECT key FROM hour_ledger_lock WHERE key = ANY(${keys}::text[]) ORDER BY key FOR UPDATE`;
  }
}

export interface HourHistory extends LedgerKey {
  id: string;
  version: number;
  status: 'current' | 'superseded' | 'voided';
  hours: string;
  origin_schedule_revision: number;
  misconduct_reported: 'none' | 'reported' | 'not_provided';
  misconduct_fact?: string;
  misconduct_version: number;
  reusable_facts?: readonly string[];
  remark?: string;
}

export async function readHistory(tx: Tx, keys: readonly StudentDay[]) {
  if (!keys.length) return [];
  return tx.$queryRaw<HourHistory[]>`
    SELECT record.id, record.version, record.activity_id, record.student_id,
      to_char(record.service_date, 'YYYY-MM-DD') AS service_date, record.status, record.hours::text,
      record.origin_schedule_revision, record.misconduct_reported, record.misconduct_fact,
      record.misconduct_version, record.remark
    FROM hour_record AS record JOIN jsonb_to_recordset(${JSON.stringify(distinctDays(keys))}::jsonb)
      AS requested(student_id uuid, service_date date) USING (student_id, service_date)
    WHERE EXISTS (SELECT 1 FROM hour_import_batch b WHERE b.id = record.batch_id AND b.status = 'approved')
       OR EXISTS (SELECT 1 FROM hour_correction_group g WHERE g.id = record.correction_group_id AND g.status = 'approved')
    ORDER BY record.version DESC, record.created_at DESC NULLS LAST, record.id`;
}

export function indexHistory(history: readonly HourHistory[]) {
  const existing = new Map<string, HourHistory>();
  const daily = new Map<string, number>();
  for (const row of history) {
    const key = recordKey(row), prior = existing.get(key);
    if (!prior || (row.status === 'current' && prior.status !== 'current')
      || (prior.status === 'superseded' && row.status === 'voided')
      || (prior.status === row.status && prior.version < row.version)) existing.set(key, row);
    if (row.status === 'current') {
      const key = dayKey(row);
      daily.set(key, (daily.get(key) ?? 0) + tenths(row.hours));
    }
  }
  return { existing, daily };
}

export async function readFactReviews(tx: Tx, keys: readonly StudentDay[]) {
  if (!keys.length) return new Map<string, HourMisconductReview>();
  const rows = await tx.$queryRaw<(LedgerKey & { fact: string; result: HourMisconductReview })[]>`
    SELECT latest.student_id, to_char(latest.service_date, 'YYYY-MM-DD') AS service_date,
      latest.activity_id, latest.fact, latest.result
    FROM (
      SELECT DISTINCT ON (review.student_id, review.service_date, review.activity_id, review.fact) review.*
      FROM hour_fact_review AS review JOIN jsonb_to_recordset(${JSON.stringify(distinctDays(keys))}::jsonb)
        AS requested(student_id uuid, service_date date) USING (student_id, service_date)
      ORDER BY review.student_id, review.service_date, review.activity_id, review.fact, review.created_at DESC, review.id
    ) AS latest
    LEFT JOIN incident ON incident.id = latest.incident_id
    WHERE latest.incident_id IS NULL OR incident.status = 'confirmed'`;
  return new Map(rows.map((row) => [factKey(row, row.fact), row.result]));
}

export function approvedCoverage(revisions: readonly { revision: number; revision_state: string; content: unknown }[]) {
  return scheduleCoverage(revisions.filter((row) => row.revision_state === 'approved').map(({ revision, content }) =>
    ({ revision, schedule: (content as { schedule: ActivitySchedule }).schedule })));
}

export interface Projection extends LedgerKey {
  previous: number;
  value: number;
  duration: number | null;
  row_number: number;
  explanation: string;
}
export function projectWarnings(daily: Map<string, number>, rows: readonly Projection[]): HourWarning[] {
  const totals = new Map(daily);
  for (const row of rows) {
    const key = dayKey(row);
    totals.set(key, (totals.get(key) ?? 0) - row.previous + row.value);
  }
  return rows.flatMap((row) => row.value > 0
    ? hourWarnings(row.student_id, row.service_date, row.row_number, row.value,
      row.duration, totals.get(dayKey(row))!, row.explanation)
    : []);
}
