import { createHash } from 'node:crypto';
import type { HourImportBatch } from '../generated/prisma/client.js';

export const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const emptySummary = () => ({ warnings: [], warning_snapshot_hash: digest('[]'), progress: 0 });
export interface SourceInfo {
  source_file_name?: string; source_hash?: string; batch_code: string; activity_title: string; activity_code: string;
  submitted_by_name?: string;
  schedule_revision?: number; previous_batch_id?: string; source_description?: string; evidence_file_ids?: string[];
}
export function batchView(batch: HourImportBatch) {
  return { ...(batch.metadata as unknown as SourceInfo), ...(batch.summary as object),
    id: batch.id, activity_id: batch.activity_id, ...(batch.source_file_id && { source_file_id: batch.source_file_id }), mode: batch.mode,
    status: batch.status, version: batch.version, retry_count: batch.retry_count, submitted_by: batch.submitted_by,
    ...(batch.submitted_at && { submitted_at: batch.submitted_at.toISOString() }),
    ...(batch.reviewed_at && { reviewed_at: batch.reviewed_at.toISOString() }),
    ...(batch.reviewed_by && { reviewed_by: batch.reviewed_by }),
    ...(batch.decision_reason && { decision_reason: batch.decision_reason }),
    created_at: batch.created_at.toISOString(), updated_at: batch.updated_at.toISOString() };
}
