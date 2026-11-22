import { Injectable } from '@nestjs/common';
import type { ExportInput } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { BusinessError, envelope, invisible } from '../http.js';
import { audit } from '../audit.js';
import { validate } from '../activities/validation.js';
import { Workflow, json, wrongState, type Tx } from '../activities/workflow.js';
import {
  authorizeStoredScope,
  exportedScope,
  resolveExportScope,
} from './export-data.js';
import { ExportWorker } from './export.worker.js';

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
export class ExportService {
  constructor(
    private db: Database,
    private workflow: Workflow,
    private worker: ExportWorker,
  ) {}

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
    if (created) this.worker.wake();
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

  private async expireIfNeeded(tx: Tx, job: {
    id: string; status: string; expires_at: Date | null;
  }) {
    if (job.status === 'ready' && job.expires_at && job.expires_at.getTime() <= Date.now())
      return tx.exportJob.update({ where: { id: job.id }, data: { status: 'expired' } });
    return tx.exportJob.findUniqueOrThrow({ where: { id: job.id } });
  }

}