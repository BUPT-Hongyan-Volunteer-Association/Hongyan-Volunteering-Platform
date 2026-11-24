import { Injectable } from '@nestjs/common';
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

  private async readJob(tx: Tx, req: SessionRequest, id: string) {
    const job = await tx.exportJob.findFirst({
      where: { id, actor_id: req.actor.account_id },
      select: jobMetaSelect,
    });
    if (!job) return invisible();
    await authorizeStoredScope(tx, req.actor, exportedScope(job));
    if (job.status === 'ready' && job.expires_at && job.expires_at.getTime() <= Date.now())
      job.status = 'expired';
    return job;
  }

  async get(req: SessionRequest, id: string) {
    return envelope(await this.db.$transaction(async (tx) => view(await this.readJob(tx, req, id)), snapshot));
  }

  async download(req: SessionRequest, id: string) {
    const event = { actor_id: req.actor.account_id, action: 'download', resource_type: 'export', resource_id: id };
    const file = await this.db.$transaction(async (tx) => {
      try {
        const job = await this.readJob(tx, req, id);
        if (job.status !== 'ready' && job.status !== 'expired') return wrongState();
        const file = job.status === 'ready'
          ? await tx.exportJob.findUniqueOrThrow({ where: { id }, select: { contents: true } })
          : null;
        if (!file?.contents || !job.expires_at || job.expires_at.getTime() <= Date.now())
          throw new BusinessError(409, 'invalid_state', '文件已过期，请重新导出');
        await audit(tx, {
          ...event, reason: '下载导出文件',
          after: { result: 'ready', scope: job.scope, status: job.status, file_name: job.file_name,
            size: job.size, expires_at: job.expires_at.toISOString() },
        });
        return {
          buffer: Buffer.from(file.contents),
          fileName: job.file_name ?? '导出文件.xlsx',
          contentType: job.content_type ?? exportMime,
        };
      } catch (error) {
        if (!(error instanceof BusinessError)) throw error;
        const { code } = error.getResponse() as { code: string };
        await audit(tx, {
          ...event, reason: '下载被拒绝：' + code, after: { result: 'denied', error: code },
        });
        // 提交拒绝访问的记录后，再将业务错误交给 HTTP 层。
        return error;
      }
    }, snapshot);
    if (file instanceof BusinessError) throw file;
    return file;
  }
}
