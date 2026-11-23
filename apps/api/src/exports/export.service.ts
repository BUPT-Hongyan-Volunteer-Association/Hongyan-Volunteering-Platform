import { Injectable, Logger } from '@nestjs/common';
import type { ExportInput } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, envelope, invisible } from '../http.js';
import { audit } from '../audit.js';
import { validate } from '../activities/validation.js';
import { Workflow, json, wrongState, type Tx } from '../activities/workflow.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  authorizeStoredScope,
  exportedScope,
  exportMime,
  resolveExportScope,
} from './export-data.js';
import { ExportWorker } from './export.worker.js';

const snapshot = { isolationLevel: 'RepeatableRead' } as const;
const jobMetaSelect = {
  id: true,
  actor_id: true,
  version: true,
  status: true,
  scope: true,
  file_name: true,
  content_type: true,
  size: true,
  expires_at: true,
  error_message: true,
  created_at: true,
  updated_at: true,
} as const;
type JobMeta = Prisma.ExportJobGetPayload<{ select: typeof jobMetaSelect }>;

interface JobView {
  id: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  error_message?: string;
}

function view(job: JobMeta): JobView {
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
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private db: Database,
    private workflow: Workflow,
    private worker: ExportWorker,
  ) {}

  async create(req: SessionRequest, body: unknown) {
    let created: string | undefined;
    // 导出不属于活动事务，target 传 null；复用 Workflow 的会话复核、幂等键和命令回执。
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
        select: jobMetaSelect,
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
    if (created) this.worker.wake();
    return response;
  }

  async get(req: SessionRequest, id: string) {
    return envelope(await this.db.$transaction(async (tx) => {
      const job = await tx.exportJob.findFirst({
        where: { id, actor_id: req.actor.account_id },
        select: jobMetaSelect,
      });
      if (!job) return invisible();
      await authorizeStoredScope(tx, req.actor, exportedScope(job));
      return view(await this.expireIfNeeded(tx, job));
    }, snapshot));
  }

  async download(req: SessionRequest, id: string) {
    let job: JobMeta | undefined;
    let file: {
      contents: Uint8Array | null;
      file_name: string | null;
      content_type: string | null;
      expires_at: Date | null;
    } | null | undefined;
    try {
      job = await this.db.$transaction(async (tx) => {
        const found = await tx.exportJob.findFirst({
          where: { id, actor_id: req.actor.account_id },
          select: jobMetaSelect,
        });
        if (!found) invisible();
        await authorizeStoredScope(tx, req.actor, exportedScope(found));
        const current = await this.expireIfNeeded(tx, found);
        if (current.status === 'expired') {
          throw new BusinessError(409, 'invalid_state', '文件已过期，请重新导出');
        }
        if (current.status !== 'ready') return wrongState();
        return current;
      }, snapshot);
      file = await this.db.exportJob.findUnique({
        where: { id },
        select: { contents: true, file_name: true, content_type: true, expires_at: true },
      });
      if (!file?.contents || !file.expires_at || file.expires_at.getTime() <= Date.now())
        throw new BusinessError(409, 'invalid_state', '文件已过期，请重新导出');
    } catch (error) {
      await this.recordDownload(req, id, 'denied', error, job);
      throw error;
    }
    await this.recordDownload(req, id, 'ready', undefined, job);
    return {
      buffer: Buffer.from(file!.contents!),
      fileName: file!.file_name ?? '导出文件.xlsx',
      contentType: file!.content_type ?? exportMime,
    };
  }

  private async recordDownload(
    req: SessionRequest,
    id: string,
    result: 'ready' | 'denied',
    error?: unknown,
    job?: JobMeta,
  ) {
    const failed =
      error instanceof BusinessError
        ? (error.getResponse() as { code?: string }).code ?? 'error'
        : error
          ? 'internal_error'
          : undefined;
    try {
      await this.db.$transaction((tx) => audit(tx, {
        actor_id: req.actor.account_id,
        action: 'download',
        resource_type: 'export',
        resource_id: id,
        reason: result === 'ready' ? '下载导出文件' : '下载被拒绝：' + (failed ?? 'unknown'),
        after: {
          result,
          ...(failed && { error: failed }),
          ...(job && {
            scope: job.scope,
            status: job.status,
            file_name: job.file_name,
            size: job.size,
            expires_at: job.expires_at?.toISOString(),
          }),
        },
      }));
    } catch (auditError) {
      this.logger.error('记录导出下载审计失败 ' + id,
        auditError instanceof Error ? auditError.stack : String(auditError));
    }
  }

  private async expireIfNeeded(tx: Tx, job: Pick<JobMeta, 'id' | 'status' | 'expires_at'>): Promise<JobMeta> {
    if (job.status === 'ready' && job.expires_at && job.expires_at.getTime() <= Date.now())
      return tx.exportJob.update({
        where: { id: job.id },
        data: { status: 'expired' },
        select: jobMetaSelect,
      });
    return tx.exportJob.findUniqueOrThrow({ where: { id: job.id }, select: jobMetaSelect });
  }
}