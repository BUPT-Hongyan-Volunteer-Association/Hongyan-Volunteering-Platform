import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Database } from '../database.js';
import { exportBuffer, exportContent, exportMime, exportedScope } from './export-data.js';

const expiryMs = 24 * 60 * 60 * 1000;
const pollMs = 2000;
const cleanupMs = 10 * 60 * 1000;
const staleMs = 30 * 60 * 1000;

@Injectable()
export class ExportWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExportWorker.name);
  private timer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;

  constructor(private db: Database) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => this.wake(), pollMs);
    this.timer.unref();
    this.cleanupTimer = setInterval(() => void this.cleanup(), cleanupMs);
    this.cleanupTimer.unref();
    this.wake();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.active;
  }

  wake() {
    if (this.stopped || this.active) return;
    this.active = this.drain()
      .catch((error) => this.logger.error('导出批处理异常', error instanceof Error ? error.stack : String(error)))
      .finally(() => {
        this.active = undefined;
      });
  }

  private async drain() {
    while (!this.stopped) {
      const claim = await this.db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM export_job
          WHERE status = 'pending' OR (status = 'running' AND updated_at < ${new Date(Date.now() - staleMs)})
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return undefined;
        return tx.exportJob.update({
          where: { id: row.id },
          data: { status: 'running', version: { increment: 1 } },
          select: { id: true, version: true, scope: true },
        });
      });
      if (!claim) return;
      try {
        const content = await this.db.$transaction(
          (tx) => exportContent(tx, exportedScope(claim)),
          { isolationLevel: 'RepeatableRead' },
        );
        const buffer = exportBuffer(content.sheet);
        await this.db.exportJob.updateMany({
          where: { id: claim.id, status: 'running', version: claim.version },
          data: {
            status: 'ready',
            version: { increment: 1 },
            file_name: content.fileName,
            content_type: exportMime,
            size: buffer.length,
            contents: buffer,
            expires_at: new Date(Date.now() + expiryMs),
            error_message: null,
          },
        });
      } catch (error) {
        this.logger.error('导出文件生成失败 ' + claim.id, error instanceof Error ? error.stack : String(error));
        await this.db.exportJob.updateMany({
          where: { id: claim.id, status: 'running', version: claim.version },
          data: { status: 'failed', version: { increment: 1 }, error_message: '文件生成失败，请重新导出' },
        });
      }
    }
  }

  private async cleanup() {
    try {
      await this.db.exportJob.updateMany({
        where: { OR: [
          { status: 'ready', expires_at: { lte: new Date() } },
          { status: 'expired', contents: { not: null } },
        ] },
        data: { status: 'expired', contents: null, version: { increment: 1 } },
      });
    } catch (error) {
      this.logger.error('清理过期导出文件失败', error instanceof Error ? error.stack : String(error));
    }
  }
}
