import { createHash } from 'node:crypto';
import type { HourImportBatch } from '../generated/prisma/client.js';
import type { Tx } from '../activities/workflow.js';
import type { HourHistory } from './preview.js';

export const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const emptySummary = () => ({ warnings: [], warning_snapshot_hash: digest('[]'), progress: 0 });
export interface SourceInfo {
  source_file_name: string; source_hash: string; batch_code: string; activity_title: string; activity_code: string;
  schedule_revision?: number; previous_batch_id?: string; source_description?: string; evidence_file_ids?: string[];
}
export function batchView(batch: HourImportBatch) {
  return { ...(batch.metadata as unknown as SourceInfo), ...(batch.summary as object),
    id: batch.id, activity_id: batch.activity_id, source_file_id: batch.source_file_id, mode: batch.mode,
    status: batch.status, version: batch.version, retry_count: batch.retry_count, submitted_by: batch.submitted_by,
    created_at: batch.created_at.toISOString(), updated_at: batch.updated_at.toISOString() };
}

export async function readHistory(tx: Tx, dates: readonly { student_id: string; service_date: string }[]) {
  if (!dates.length) return [];
  return tx.$queryRaw<HourHistory[]>`
    SELECT record.id, record.version, record.activity_id, record.student_id,
      to_char(record.service_date,'YYYY-MM-DD') AS service_date, record.status, record.hours::text,
      record.origin_schedule_revision, record.misconduct_reported, record.misconduct_fact,
      record.misconduct_version, record.reusable_facts
    FROM hour_record AS record JOIN jsonb_to_recordset(${JSON.stringify(dates)}::jsonb)
      AS requested(student_id uuid, service_date date) USING (student_id, service_date)`;
}
