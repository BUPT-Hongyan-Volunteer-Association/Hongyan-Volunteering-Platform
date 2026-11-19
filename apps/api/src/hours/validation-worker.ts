import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { FieldError } from '@hongyan/contracts/types';
import { Database } from '../database.js';
import { BusinessError, denied } from '../http.js';
import { json, stable, type Tx } from '../activities/workflow.js';
import { previewActivityHours } from './preview-context.js';
import { readHourUpload } from './upload-input.js';
import { digest, emptySummary, readHistory, type SourceInfo } from './batch-data.js';
import { errorWorkbook } from './error-report.js';

@Injectable()
export class HourValidationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private db: Database) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.wake(), 3000);
    this.timer.unref();
  }
  wake() {
    if (this.stopped || this.active) return;
    this.active = this.drain().catch((error) => Logger.error({ worker: 'hour-validation', error: error.name }))
      .finally(() => { this.active = undefined; });
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
  }
  private async drain() {
    while (!this.stopped) {
      let claim: { id: string; version: number } | undefined;
      try {
        const worked = await this.db.$transaction(async (tx) => {
          [claim] = await tx.$queryRaw<{ id: string; version: number }[]>`
            SELECT id, version FROM hour_import_batch WHERE status='validating'
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (!claim) return false;
          await this.validate(tx, claim.id);
          return true;
        }, { isolationLevel: 'RepeatableRead', timeout: 60000 });
        if (!worked) return;
      } catch (error) {
        if (!claim) throw error;
        Logger.error({ worker: 'hour-validation', batch: claim.id, error: error instanceof Error ? error.name : 'Unknown' });
        await this.db.hourImportBatch.updateMany({ where: { ...claim, status: 'validating' },
          data: { status: 'failed', version: { increment: 1 }, summary: {
            ...emptySummary(), error_message: '系统校验未完成，可在原批次重试。' } } });
      }
    }
  }
  private async validate(tx: Tx, id: string) {
    const batch = await tx.hourImportBatch.findUniqueOrThrow({ where: { id }, include: { source: true } });
    const info = batch.metadata as unknown as SourceInfo;
    const account = await tx.account.findUnique({ where: { id: batch.validation_by, active: true, must_change_password: false },
      include: { roles: { where: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } } } });
    if (!account) return denied();
    const actor = { account_id: account.id, username: account.username, display_name: account.display_name,
      roles: account.roles.map((role) => role.role), must_change_password: false };
    let summary: object, errors: FieldError[];
    try {
      const book = await readHourUpload(tx, actor, batch.activity_id, batch.source.name, Buffer.from(batch.source.contents));
      const preview = await previewActivityHours(tx, actor, batch.activity_id, book, {
        mode: batch.mode === 'new' ? 'new' : 'correction', now: new Date(), schedule_revision: info.schedule_revision,
      }, readHistory);
      const { rows, ...counts } = preview;
      for (let offset = 0; offset < rows.length; offset += 250) {
        await tx.hourImportRow.createMany({ data: rows.slice(offset, offset+250).map((row) => ({
          batch_id: id, row_number: row.row_number, action: row.action,
          needs_review: !!row.misconduct_requires_review, detail: json(row),
        })) });
      }
      errors = rows.flatMap((row) => row.errors);
      summary = { ...counts, template_structure: book.template_structure, warning_snapshot_hash: digest(stable(preview.warnings)),
        ...(errors.length && { error_message: '请按错误报告修正后重新上传。' }) };
    } catch (error) {
      if (!(error instanceof BusinessError) || error.getStatus() !== 422) throw error;
      errors = (error.getResponse() as { details?: FieldError[] }).details ??
        [{ field: 'file', code: 'validation_error', message: error.message }];
      summary = { ...emptySummary(), error_message: error.message + '；请修正后重新上传。' };
    }
    let report_file_id: string | undefined;
    if (errors.length) {
      const contents = errorWorkbook(errors);
      const report = await tx.hourImportFile.create({ data: { activity_id: batch.activity_id,
        purpose: 'hour_error_report', name: info.batch_code + '-校验错误.xlsx', size: contents.byteLength,
        contents: new Uint8Array(contents) }, select: { id: true } });
      report_file_id = report.id;
    }
    await tx.hourImportBatch.update({ where: { id }, data: { report_file_id,
      status: errors.length ? 'invalid' : 'ready', version: { increment: 1 }, summary: json({ ...summary, progress: 100 }) } });
  }
}
