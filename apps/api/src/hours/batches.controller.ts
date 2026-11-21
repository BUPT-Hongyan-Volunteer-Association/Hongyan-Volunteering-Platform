import { approvedOrigin } from './read-ledger.js';
import { Body, CallHandler, CanActivate, Controller, ExecutionContext, Get, Header, HttpCode, Injectable, Param, ParseUUIDPipe, PayloadTooLargeException,
  Post, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { ActivityInput, HourBatchReviewDecision, HourBatchSubmit, ReasonAction, VersionAction } from '@hongyan/contracts/types';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import { managedScope, pagination, staff } from '../activities/read.js';
import { Workflow, checkVersion, json, wrongState } from '../activities/workflow.js';
import { validate } from '../activities/validation.js';
import { batchView, digest, emptySummary, mime } from './batch-data.js';
import { HourValidationWorker } from './validation-worker.js';
import { requestVoid, reviewBatch, submitBatch } from './batch-review.js';

const maxSize = 5242880;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const statuses = ['validating','invalid','ready','pending_review','approved','rejected','failed'];
const metadataOnly = { id: true, name: true, size: true, purpose: true, created_at: true } as const;
type QueryValues = Record<string,string>;
type Upload = { originalname: string; buffer: Buffer };
@Injectable()
class HourWorkbookFile extends FileInterceptor('file', { limits: { fileSize: maxSize + 1, files: 1, fields: 64, fieldSize: 8192 } }) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try { return await super.intercept(context,next); }
    catch (error) {
      if (error instanceof PayloadTooLargeException) return invalid('file','工作簿不能超过 5 MB');
      throw error;
    }
  }
}
function choice(value: unknown, field: string, choices: string[]) {
  if (typeof value !== 'string' || !choices.includes(value)) return invalid(field,'不支持的选项');
  return value;
}
function options(body: Record<string,unknown>) {
  const allowed = ['mode','schedule_revision','previous_batch_id','source_description','evidence_file_ids'];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(key,'未知的上传参数');
  const mode = choice(body.mode,'mode',['new','correction']);
  const revision = body.schedule_revision;
  if (revision !== undefined && (mode !== 'new' || typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision)
    || !Number.isSafeInteger(Number(revision)) || Number(revision) > 2147483647)) invalid('schedule_revision','仅新增模式可指定正整数安排版本');
  const previous = body.previous_batch_id, description = body.source_description;
  if (previous !== undefined && (typeof previous !== 'string' || !uuid.test(previous))) return invalid('previous_batch_id','批次 ID 无效');
  if (description !== undefined && (typeof description !== 'string' || !description.trim() || [...description].length > 2000)) return invalid('source_description','说明须为 1 至 2000 字');
  const evidence = body.evidence_file_ids === undefined ? [] : [body.evidence_file_ids].flat();
  if (!evidence.every((id): id is string => typeof id === 'string' && uuid.test(id))) return invalid('evidence_file_ids','附件 ID 无效');
  return { mode, ...(revision && { schedule_revision: Number(revision) }), ...(previous && { previous_batch_id: previous }),
    ...(description && { source_description: description }), ...(evidence.length && { evidence_file_ids: [...new Set(evidence)] }) };
}

@Injectable()
export class HourUploadScope implements CanActivate {
  constructor(private db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<SessionRequest>();
    const id = req.params.id;
    if (typeof id !== 'string' || !uuid.test(id)) return invalid('id','活动 ID 无效');
    if (!await this.db.activity.findFirst({ where: { id, ...managedScope(req.actor) }, select: { id: true } })) return invisible();
    return true;
  }
}

@Controller()
export class HourBatchesController {
  constructor(private db: Database, private commands: Workflow, private worker: HourValidationWorker) {}
  @Post('organizer/activities/:id/hour-imports') @HttpCode(202)
  @UseGuards(HourUploadScope)
  @UseInterceptors(HourWorkbookFile)
  async upload(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest,
    @UploadedFile() file: Upload | undefined, @Body() body: Record<string,unknown>) {
    if (!file || !/\.xlsx$/i.test(file.originalname) || file.buffer.length > maxSize) return invalid('file','只接受不超过 5 MB 的 .xlsx 工作簿');
    const rawName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const source_file_name = /[^\u0000-\u00ff]/.test(file.originalname) || rawName.includes('\uFFFD') ? file.originalname : rawName;
    const source_hash = digest(file.buffer);
    const input = options(body);
    const response = await this.commands.run(req, { activityId: id }, 'manage', async (tx, activity) => {
      if (!activity) return invisible();
      const { mode, ...fields } = input;
      if (fields.previous_batch_id && !await tx.hourImportBatch.findFirst({ where: { id: fields.previous_batch_id, activity_id:id } })) return invisible();
      if (fields.evidence_file_ids && await tx.hourImportFile.count({ where: { activity_id:id, purpose:'evidence',
        id:{in:fields.evidence_file_ids} } }) !== fields.evidence_file_ids.length) return invalid('evidence_file_ids','附件不存在或不可用');
      const revision = mode === 'new' ? fields.schedule_revision ?? activity.published_revision : undefined;
      if (mode === 'new' && !activity.revisions.some((item) => item.revision === revision && item.revision_state === 'approved')) {
        return invalid('schedule_revision','活动没有对应的获批安排');
      }
      const display = activity.revisions.find((item) => item.revision === activity.published_revision)
        ?? activity.revisions.find((item) => item.revision === activity.working_revision);
      const fileRow = await tx.hourImportFile.create({ data: { activity_id:id, name:source_file_name, size:file.buffer.length,
        purpose:'hour_import_source', contents:new Uint8Array(file.buffer) }, select:{id:true} });
      const batchId = randomUUID();
      return batchView(await tx.hourImportBatch.create({ data: { id:batchId, activity_id:id, source_file_id:fileRow.id, mode,
        submitted_by:req.actor.account_id, validation_by:req.actor.account_id, summary:emptySummary(),
        metadata:json({ ...fields, source_file_name, source_hash, batch_code:'H-'+batchId, activity_code:activity.activity_code,
          activity_title:(display?.content as unknown as ActivityInput)?.title ?? activity.activity_code,
          ...(revision && { schedule_revision:revision }) }) } }));
    }, undefined, { ...input, source_file_name, source_hash });
    this.worker.wake();
    return response;
  }

  @Get('organizer/activities/:id/hour-imports')
  async list(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.page(req, query, id, false);
  }

  @Get('admin/hour-imports')
  async queue(@Req() req: SessionRequest, @Query() query: QueryValues) {
    if (!staff(req.actor)) denied();
    if (query.activity_id !== undefined && !uuid.test(query.activity_id)) invalid('activity_id', '活动 ID 无效');
    return this.page(req, query, query.activity_id, true);
  }

  private page(req: SessionRequest, query: QueryValues, id: string | undefined, admin: boolean) {
    const {page,page_size,skip} = pagination(query);
    const status = query.status === undefined ? undefined : choice(query.status,'status',statuses);
    const mode = query.mode === undefined ? undefined : choice(query.mode,'mode',['new','correction','void']);
    return this.db.$transaction(async (tx) => {
      if (!admin && !await tx.activity.findFirst({where:{id,...managedScope(req.actor)},select:{id:true}})) return invisible();
      const where = {activity_id:id,status,mode};
      const total = await tx.hourImportBatch.count({ where });
      const batches = await tx.hourImportBatch.findMany({where,skip,take:page_size,orderBy:[{created_at:'desc'},{id:'desc'}]});
      return envelope({items:batches.map(batchView),total,page,page_size});
    },{isolationLevel:'RepeatableRead'});
  }

  @Get('hour-imports/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const batch = await this.db.hourImportBatch.findFirst({where:{id,activity:managedScope(req.actor)}});
    return envelope(batchView(batch ?? invisible()));
  }

  @Get('hour-imports/:id/rows')
  async rows(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    const {page,page_size,skip} = pagination(query);
    const action = query.action === undefined ? undefined : choice(query.action,'action',['add','correct','void','error','skip_identical','review_only']);
    const flag = query.misconduct_requires_review;
    const needs_review = flag === undefined ? undefined : choice(flag,'misconduct_requires_review',['true','false']) === 'true';
    return this.db.$transaction(async (tx) => {
      if (!await tx.hourImportBatch.findFirst({where:{id,activity:managedScope(req.actor)},select:{id:true}})) return invisible();
      const where = {batch_id:id,action,needs_review};
      const total = await tx.hourImportRow.count({where});
      const rows = await tx.hourImportRow.findMany({where,skip,take:page_size,orderBy:{row_number:'asc'},select:{detail:true}});
      return envelope({items:rows.map((row) => row.detail),page,page_size,total});
    },{isolationLevel:'RepeatableRead'});
  }

  @Post('hour-imports/:id/submit') @HttpCode(200)
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const batch = await this.db.hourImportBatch.findFirst({ where: { id, activity: managedScope(req.actor) } });
    if (!batch) invisible();
    const input = validate<HourBatchSubmit>('hour_batch_submit', req.body);
    return this.commands.run(req, { activityId: batch.activity_id }, 'manage', (tx, activity, actor, reauthorize) =>
      submitBatch(tx, activity!, id, input, actor, req.receivedAt, reauthorize));
  }

  @Post('admin/hour-imports/:id/decision') @HttpCode(200)
  async decision(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    if (!staff(req.actor)) denied();
    const batch = await this.db.hourImportBatch.findUnique({ where: { id }, select: { activity_id: true } });
    if (!batch) invisible();
    const input = validate<HourBatchReviewDecision>('hour_batch_review_decision', req.body);
    return this.commands.run(req, { activityId: batch.activity_id }, 'review', (tx, activity, actor, reauthorize) =>
      reviewBatch(tx, activity!, id, input, actor, req.receivedAt, reauthorize));
  }

  @Post('organizer/hour-records/:id/void-requests')
  async voidRequest(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const record = await this.db.hourRecord.findFirst({
      where: { id, activity: managedScope(req.actor), ...approvedOrigin }, select: { activity_id: true },
    });
    if (!record) invisible();
    const input = validate<ReasonAction>('reason_action', req.body);
    return this.commands.run(req, { activityId: record.activity_id }, 'manage', (tx, activity, actor, reauthorize) =>
      requestVoid(tx, activity!, id, input, actor, req.receivedAt, reauthorize));
  }

  @Post('hour-imports/:id/retry') @HttpCode(202)
  async retry(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const batch = await this.db.hourImportBatch.findFirst({where:{id,activity:managedScope(req.actor)},select:{activity_id:true}});
    if (!batch) return invisible();
    const response = await this.commands.run(req,{activityId:batch.activity_id},'manage',async (tx) => {
      const {expected_version} = validate<VersionAction>('version_action',req.body);
      const current = await tx.hourImportBatch.findUniqueOrThrow({where:{id},select:{version:true}});
      checkVersion(current.version,expected_version);
      const changed = await tx.hourImportBatch.updateMany({ where:{id,status:'failed',version:expected_version}, data:{status:'validating',
        retry_count:{increment:1},version:{increment:1},validation_by:req.actor.account_id,summary:emptySummary()} });
      if (!changed.count) return wrongState();
      return batchView(await tx.hourImportBatch.findUniqueOrThrow({where:{id}}));
    });
    this.worker.wake();
    return response;
  }

  @Get('hour-imports/:id/error-report')
  async report(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest) {
    const batch = await this.db.hourImportBatch.findFirst({where:{id,activity:managedScope(req.actor)},
      select:{report:{select:metadataOnly}}});
    if (!batch?.report) return invisible();
    return envelope({...batch.report,content_type:mime});
  }

  @Get('files/:id/download') @Header('Cache-Control','private, no-store')
  async download(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Res({passthrough:true}) res: Response) {
    const file = await this.db.hourImportFile.findFirst({where:{id,purpose:{in:['hour_error_report','hour_import_source']},
      activity:managedScope(req.actor)}});
    if (!file) return invisible();
    res.setHeader('X-Content-Type-Options','nosniff');
    return new StreamableFile(Buffer.from(file.contents),{type:mime,length:file.size,
      disposition:"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/'/g,'%27')});
  }
}
