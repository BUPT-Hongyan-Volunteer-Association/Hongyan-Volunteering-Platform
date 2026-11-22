import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { ExportInput } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, envelope, invisible } from '../http.js';
import { audit } from '../audit.js';
import { validate } from '../activities/validation.js';
import { Workflow, json, wrongState, type Tx } from '../activities/workflow.js';
import {
  authorizeStoredScope,
  exportBuffer,
  exportContent,
  exportedScope,
  resolveExportScope,
} from './export-data.js';

const expiryMs = 24 * 60 * 60 * 1000;
const cleanupMs = 10 * 60 * 1000;
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const snapshot = { isolationLevel: 'RepeatableRead' } as const;

interface JobView {
  id: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  error_message?: string;
}

function view(job: {
  id: string; version: number; status: string; created_at: Date; updated_at: Date;
  expires_at: Date | null; error_message: string | null;
}): JobView {
  return {
    id: job.id,
    version: job.version,
    status: job.status,
    created_at: job.created_at.toISOString(),
    updated_at: job.updated_at.toISOString(),
    ...(job.expires_at && { expires_at: job.expires_at.toISOString() }),
    ...(job.error_message && { error_message: job.error_message }),
  };
}

@Injectable()
export class ExportService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExportService.name);
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}

  async onApplicationBootstrap() {
    const pending = await this.db.exportJob.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    for (const job of pending) {
      await this.db.exportJob.update({
        where: { id: job.id },
        data: { status: 'pending', error_message: null },
      });
      this.schedule(job.id);
    }
    this.cleanupTimer = setInterval(() => void this.cleanup(), cleanupMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async create(req: SessionRequest, body: unknown) {
    let created: string | undefined;
    const response = await this.workflow.run(req, null, 'export', async (tx, _row, actor) => {
      const input = validate<ExportInput>('export_input', body);
      const scope = await resolveExportScope(tx, actor, input);
      const job = await tx.exportJob.create({
        data: {
          actor_id: actor.account_id,
          type: input.type,
          scope: json(scope),
          status: 'pending',
        },
      });
      created = job.id;
      await audit(tx, {
        actor_id: actor.account_id,
        action: 'create',
        resource_type: 'export',
        resource_id: job.id,
        after: { type: input.type, scope },
      });
      return view(job);
    });
    if (created) this.schedule(created);
    return response;
  }

  async get(req: SessionRequest, id: string) {
    return envelope(await this.db.$transaction(async (tx) => {
      const job = await tx.exportJob.findFirst({
        where: { id, actor_id: req.actor.account_id },
      });
      if (!job) return invisible();
      await authorizeStoredScope(tx, req.actor, exportedScope(job));
      return view(await this.expireIfNeeded(tx, job));
    }, snapshot));
  }

  async download(req: SessionRequest, id: string) {
    const { file, buffer } = await this.db.$transaction(async (tx) => {
      const job = await tx.exportJob.findFirst({
        where: { id, actor_id: req.actor.account_id },
      });
      if (!job) return invisible();
      const scope = exportedScope(job);
      await authorizeStoredScope(tx, req.actor, scope);
      const current = await this.expireIfNeeded(tx, job);
      if (current.status === 'expired') {
        throw new BusinessError(409, 'invalid_state', '文件已过期，请重新导出');
      }
      if (current.status !== 'ready' || !current.contents) {
        if (current.status === 'ready') throw new BusinessError(409, 'invalid_state', '文件已过期，请重新导出');
        return wrongState();
      }
      await audit(tx, {
        actor_id: req.actor.account_id,
        action: 'download',
        resource_type: 'export',
        resource_id: current.id,
        after: {
          file_name: current.file_name,
          size: current.size,
          expires_at: current.expires_at?.toISOString(),
          scope,
        },
      });
      return { file: current, buffer: Buffer.from(current.contents) };
    }, snapshot);
    return {
      buffer,
      fileName: file.file_name ?? '导出文件.xlsx',
      contentType: file.content_type ?? mime,
    };
  }

  private schedule(id: string) {
    setImmediate(() => void this.generate(id));
  }

  private async expireIfNeeded(tx: Tx, job: {
    id: string; status: string; expires_at: Date | null;
  }) {
    if (job.status === 'ready' && job.expires_at && job.expires_at.getTime() <= Date.now())
      return tx.exportJob.update({ where: { id: job.id }, data: { status: 'expired' } });
    return tx.exportJob.findUniqueOrThrow({ where: { id: job.id } });
  }

  private async generate(id: string) {
    const started = await this.db.exportJob.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'running' },
    });
    if (!started.count) return;
    try {
      await this.db.$transaction(async (tx) => {
        const job = await tx.exportJob.findUniqueOrThrow({ where: { id } });
        const content = await exportContent(tx, exportedScope(job));
        const buffer = exportBuffer(content.sheet);
        await tx.exportJob.update({
          where: { id },
          data: {
            status: 'ready',
            file_name: content.fileName,
            content_type: mime,
            size: buffer.length,
            contents: buffer,
            expires_at: new Date(Date.now() + expiryMs),
            error_message: null,
          },
        });
      }, { isolationLevel: 'RepeatableRead' });
    } catch (error) {
      this.logger.error('导出文件生成失败 ' + id, error instanceof Error ? error.stack : String(error));
      await this.db.exportJob.updateMany({
        where: { id, status: { in: ['pending', 'running'] } },
        data: { status: 'failed', error_message: '文件生成失败，请重新导出' },
      });
    }
  }

  private async cleanup() {
    try {
      await this.db.exportJob.updateMany({
        where: { status: 'ready', expires_at: { lte: new Date() } },
        data: { status: 'expired', contents: null },
      });
      await this.db.exportJob.updateMany({
        where: { status: 'expired', contents: { not: null } },
        data: { contents: null },
      });
    } catch (error) {
      this.logger.error('清理过期导出文件失败', error instanceof Error ? error.stack : String(error));
    }
  }
}