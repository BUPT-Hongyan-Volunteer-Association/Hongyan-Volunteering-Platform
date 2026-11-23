import { studentView } from './student-profile.js';
import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma, StudentImportBatch } from '../generated/prisma/client.js';
import { hashPassword } from '../auth/password.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { pagination } from '../activities/read.js';
import { Database } from '../database.js';
import { BusinessError, invalid, invisible } from '../http.js';
import {
  counts,
  evaluateRows,
  maxImportBytes,
  parseImportWorkbook,
  profileMatches,
  readImportFields,
  type EvaluatedRow,
  type ExistingStudent,
  type FieldIssue,
} from './import.js';
import { Workflow, checkVersion } from '../activities/workflow.js';

export interface UploadedStudentFile {
  buffer: Buffer;
  size: number;
  originalname: string;
}

interface CommitInput {
  expected_version: number;
  source_hash: string;
}

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** 新增账号的初始密码为学号后六位，与既有登录服务保持一致。 */
const initialPassword = (student_no: string) => student_no.slice(-6);

async function hashAccounts(student_nos: string[]) {
  const hashes = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, student_nos.length) }, async () => {
    while (cursor < student_nos.length) {
      const student_no = student_nos[cursor++]!;
      hashes.set(student_no, await hashPassword(initialPassword(student_no)));
    }
  });
  await Promise.all(workers);
  return hashes;
}

function importView(batch: StudentImportBatch) {
  return {
    id: batch.id,
    version: batch.version,
    status: batch.status,
    source_hash: batch.source_hash,
    row_count: batch.row_count,
    created_count: batch.created_count,
    skipped_count: batch.skipped_count,
    error_count: batch.error_count,
    ...(batch.error_message && { error_message: batch.error_message }),
    created_at: batch.created_at.toISOString(),
    updated_at: batch.updated_at.toISOString(),
  };
}

function rowView(row: {
  row_number: number;
  action: string;
  student_no: string | null;
  name: string | null;
  cohort: string | null;
  grade: string | null;
  class_name: string | null;
  college: string | null;
  raw_values: Prisma.JsonValue;
  errors: Prisma.JsonValue;
  resulting_account_status: string | null;
}) {
  return {
    row_number: row.row_number,
    action: row.action,
    ...(row.student_no && { student_no: row.student_no }),
    ...(row.name && { name: row.name }),
    ...(row.cohort && { cohort: row.cohort }),
    ...(row.grade && { grade: row.grade }),
    ...(row.class_name && { class_name: row.class_name }),
    ...(row.college && { college: row.college }),
    errors: row.errors as unknown as FieldIssue[],
    raw_values: row.raw_values as unknown as Record<string, string>,
    ...(row.resulting_account_status && {
      resulting_account_status: row.resulting_account_status,
    }),
  };
}

@Injectable()
export class StudentImportService implements OnApplicationBootstrap {
  constructor(private readonly db: Database, private readonly workflow: Workflow) {}

  /** 服务重启后恢复上传事务已提交、但校验回调尚未执行的批次。 */
  async onApplicationBootstrap() {
    const pending = await this.db.studentImportBatch.findMany({
      where: { status: 'validating' },
      select: { id: true },
    });
    if (!pending.length) return;
    Logger.log('恢复 ' + pending.length + ' 个未完成的学生建档校验');
    for (const batch of pending) this.schedule(batch.id);
  }

  private async loadExisting(student_nos: string[]) {
    const unique = [...new Set(student_nos)];
    const existing = new Map<string, ExistingStudent>();
    const records = await this.db.student.findMany({
      where: { student_no: { in: unique } },
      include: { account: true },
    });
    for (const record of records)
      existing.set(record.student_no, {
        student_no: record.student_no,
        has_record: true,
        name: record.account.display_name,
        cohort: record.cohort ?? '',
        grade: record.grade ?? '',
        class_name: record.class_name ?? '',
        college: record.college ?? '',
        status: record.account.active ? 'active' : 'inactive',
      });
    const accounts = await this.db.account.findMany({
      where: { username: { in: unique }, student: null },
      select: { username: true, display_name: true, active: true },
    });
    for (const account of accounts)
      if (!existing.has(account.username))
        existing.set(account.username, {
          student_no: account.username,
          has_record: false,
          name: account.display_name,
          cohort: '',
          grade: '',
          class_name: '',
          college: '',
          status: account.active ? 'active' : 'inactive',
        });
    return existing;
  }

  async create(req: SessionRequest, file: UploadedStudentFile | undefined) {
    if (!file) invalid('file', '请选择学生建档模板 .xlsx 文件');
    if (!/\.xlsx$/i.test(file.originalname ?? ''))
      invalid('file', '仅支持 .xlsx 格式的学生建档模板');
    if (!file.buffer?.length) invalid('file', '文件内容为空');
    if (file.buffer.length > maxImportBytes)
      invalid('file', '文件不得超过 5 MB（5,242,880 字节）');
    if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b)
      invalid('file', '文件不是有效的 .xlsx 工作簿');
    const source_hash = sha256(file.buffer);
    const source_name = file.originalname ?? '名单.xlsx';
    let batchId = '';
    const response = await this.workflow.run(
      req, null, 'review',
      async (tx) => {
        const batch = await tx.studentImportBatch.create({
          data: {
            status: 'validating',
            source_hash,
            source_name,
            source_data: new Uint8Array(file.buffer),
            created_by: req.actor.account_id,
          },
        });
        batchId = batch.id;
        return importView(batch);
      },
      undefined, { source_hash, source_name },
    );
    if (batchId) this.schedule(batchId);
    return response;
  }

  private schedule(batchId: string) {
    setImmediate(() => {
      void this.validate(batchId).catch((error) => Logger.error(error));
    });
  }

  private async validate(batchId: string) {
    try {
      const batch = await this.db.studentImportBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.status !== 'validating') return;
      const parsed = parseImportWorkbook(Buffer.from(batch.source_data));
      let evaluated: EvaluatedRow[] = [];
      let summary = { created_count: 0, skipped_count: 0, error_count: 0 };
      if (parsed.fields) {
        const existing = await this.loadExisting(
          parsed.rows.flatMap((row) => (row.values.student_no ? [row.values.student_no] : [])),
        );
        evaluated = evaluateRows(parsed.rows, existing, parsed.fields);
        summary = counts(evaluated);
      }
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'student-import-validate:' + batchId},0))`;
        const current = await tx.studentImportBatch.findUnique({ where: { id: batchId } });
        if (!current || current.status !== 'validating') return;
        await tx.studentImportRow.deleteMany({ where: { batch_id: batchId } });
        if (evaluated.length)
          await tx.studentImportRow.createMany({
            data: evaluated.map((row) => ({
              batch_id: batchId,
              row_number: row.row_number,
              action: row.action,
              student_no: row.values.student_no ?? null,
              name: row.values.name ?? null,
              cohort: row.values.cohort ?? null,
              grade: row.values.grade ?? null,
              class_name: row.values.class_name ?? null,
              college: row.values.college ?? null,
              raw_values: row.raw_values as Prisma.InputJsonValue,
              errors: row.errors as unknown as Prisma.InputJsonValue,
              resulting_account_status: row.resulting_account_status ?? null,
            })),
          });
        const status = parsed.file_error || summary.error_count ? 'invalid' : 'ready';
        await tx.studentImportBatch.update({
          where: { id: batchId },
          data: {
            status,
            version: { increment: 1 },
            row_count: parsed.row_count,
            ...summary,
            error_message: parsed.file_error ?? null,
          },
        });
      });
    } catch (error) {
      Logger.error({
        message: '学生建档校验失败',
        batch_id: batchId,
        error: error instanceof Error ? error.stack ?? error.name : 'UnknownError',
      });
      await this.db.studentImportBatch.updateMany({
        where: { id: batchId, status: 'validating' },
        data: {
          status: 'failed',
          error_message: '系统校验失败，请重试或重新上传',
          version: { increment: 1 },
        },
      });
    }
  }

  async get(id: string) {
    const batch = await this.db.studentImportBatch.findUnique({ where: { id } });
    if (!batch) invisible();
    return importView(batch);
  }

  async rows(id: string, query: Record<string, string>) {
    const { page, page_size, skip } = pagination(query);
    return this.db.$transaction(
      async (tx) => {
        const batch = await tx.studentImportBatch.findUnique({ where: { id }, select: { id: true } });
        if (!batch) invisible();
        const total = await tx.studentImportRow.count({ where: { batch_id: id } });
        const items =
          skip < total
            ? await tx.studentImportRow.findMany({
                where: { batch_id: id },
                orderBy: { row_number: 'asc' },
                skip,
                take: page_size,
              })
            : [];
        return { items: items.map(rowView), page, page_size, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async commit(req: SessionRequest, id: string, input: CommitInput) {
    const batch = await this.db.studentImportBatch.findUnique({
      where: { id },
      select: {
        status: true, source_data: true,
        rows: { where: { action: 'create' }, select: { student_no: true } },
      },
    });
    if (!batch) invisible();
    // 已确认批次的相同幂等键由命令回执直接返回，不再重复计算初始密码摘要。
    const ready = batch.status === 'ready';
    const fields = ready ? readImportFields(Buffer.from(batch.source_data)) : [];
    const planned = ready ? batch.rows.flatMap(row => row.student_no ? [row.student_no] : []) : [];
    const hashes = await hashAccounts([...new Set(planned)]);
    return this.workflow.run(req, null, 'review', async (tx) => {
      await tx.$queryRaw`SELECT id FROM student_import_batch WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.studentImportBatch.findUnique({
        where: { id }, select: { status: true, error_count: true, version: true, source_hash: true },
      });
      if (!current) invisible();
      if (!ready || current.status !== 'ready' || current.error_count)
        throw new BusinessError(409, 'invalid_state', '仅已就绪且无错误的批次可以确认');
      checkVersion(current.version, input.expected_version);
      if (current.source_hash !== input.source_hash)
        throw new BusinessError(409, 'conflict', '源文件摘要与批次不一致，请重新上传后再确认');
      const rows = await tx.studentImportRow.findMany({
        where: { batch_id: id },
        orderBy: { row_number: 'asc' },
      });
      const numbers = [
        ...new Set(rows.flatMap((row) => (row.student_no ? [row.student_no] : []))),
      ].sort();
      // 同一学号在不同批次间串行处理：先写入的批次建档，后写入的批次按相同资料跳过。
      for (const student_no of numbers)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'student-import:' + student_no},0))`;
      const conflicts: (FieldIssue & { row?: number })[] = [];
      let created = 0;
      let skipped = 0;
      for (const row of rows) {
        const student_no = row.student_no;
        if (!student_no) {
          conflicts.push({
            field: 'student_no',
            row: row.row_number,
            code: 'invalid_row',
            message: '缺少可导入的学号',
          });
          continue;
        }
        const account = await tx.account.findUnique({
          where: { username: student_no },
          include: { student: true },
        });
        if (account) {
          if (
            account.student &&
            profileMatches(row, { ...account.student, name: account.display_name }, fields)
          ) {
            skipped += 1;
            continue;
          }
          conflicts.push({
            field: 'student_no',
            row: row.row_number,
            code: 'profile_conflict',
            message: '学号 ' + student_no + ' 与已有学生档案资料不一致',
          });
          continue;
        }
        if (!row.name) {
          conflicts.push({
            field: 'name',
            row: row.row_number,
            code: 'invalid_row',
            message: '缺少姓名',
          });
          continue;
        }
        await tx.account.create({
          data: {
            username: student_no,
            display_name: row.name,
            password_hash: hashes.get(student_no)!,
            must_change_password: true,
            active: true,
            roles: { create: { role: 'student' } },
            student: {
              create: {
                student_no,
                cohort: row.cohort,
                grade: row.grade,
                class_name: row.class_name,
                college: row.college,
              },
            },
          },
        });
        created += 1;
      }
      if (conflicts.length)
        throw new BusinessError(
          409,
          'conflict',
          '存在 ' + conflicts.length + ' 行学生资料冲突，整批未写入',
          conflicts.slice(0, 200),
        );
      const updated = await tx.studentImportBatch.update({
        where: { id },
        data: {
          status: 'committed',
          version: { increment: 1 },
          created_count: created,
          skipped_count: skipped,
          error_count: 0,
        },
      });
      return importView(updated);
    });
  }

  async retry(req: SessionRequest, id: string, input: { expected_version: number }) {
    const batch = await this.db.studentImportBatch.findUnique({ where: { id }, select: { id: true } });
    if (!batch) invisible();
    let scheduled = false;
    const response = await this.workflow.run(req, null, 'review', async (tx) => {
      await tx.$queryRaw`SELECT id FROM student_import_batch WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.studentImportBatch.findUnique({ where: { id } });
      if (!current) invisible();
      if (current.status !== 'failed')
        throw new BusinessError(409, 'invalid_state', '仅系统处理失败的批次可以重试校验');
      checkVersion(current.version, input.expected_version);
      await tx.studentImportRow.deleteMany({ where: { batch_id: id } });
      const updated = await tx.studentImportBatch.update({
        where: { id },
        data: {
          status: 'validating',
          version: { increment: 1 },
          row_count: 0,
          created_count: 0,
          skipped_count: 0,
          error_count: 0,
          error_message: null,
        },
      });
      scheduled = true;
      return importView(updated);
    });
    if (scheduled) this.schedule(id);
    return response;
  }

  async students(query: Record<string, string>) {
    const { page, page_size, skip } = pagination(query);
    if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 100))
      invalid('q', '搜索词过长');
    if (query.cohort !== undefined && (typeof query.cohort !== 'string' || query.cohort.length > 100))
      invalid('cohort', '级部筛选值无效');
    const status = query.status;
    if (status !== undefined && status !== 'active' && status !== 'inactive')
      invalid('status', '账号状态筛选值无效');
    if (query.grade !== undefined && !/^\d{4}$/.test(query.grade.trim()))
      invalid('grade', '年级筛选值无效');
    const q = query.q?.trim();
    const cohort = query.cohort?.trim();
    const grade = query.grade?.trim();
    const where: Prisma.StudentWhereInput = {
      ...(cohort && { cohort }),
      ...(grade && { grade }),
      ...(status && { account: { active: status === 'active' } }),
      ...(q && {
        OR: [{ student_no: { contains: q } }, { account: { display_name: { contains: q } } }],
      }),
    };
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.student.count({ where });
        const gradeRows = await tx.student.findMany({
          where: { grade: { not: null } },
          select: { grade: true },
          distinct: ['grade'],
          orderBy: { grade: 'desc' },
        });
        const grade_options = gradeRows
          .map((row) => row.grade)
          .filter((value): value is string => !!value);
        const cohortRows = await tx.student.findMany({
          where: { cohort: { not: null } },
          select: { cohort: true },
          distinct: ['cohort'],
          orderBy: { cohort: 'asc' },
        });
        const cohort_options = cohortRows
          .map((row) => row.cohort)
          .filter((value): value is string => !!value);
        const items =
          skip < total
            ? await tx.student.findMany({
                where,
                include: { account: { select: { display_name: true, active: true } } },
                orderBy: { student_no: 'asc' },
                skip,
                take: page_size,
              })
            : [];
        return {
          items: items.map(studentView),
          page,
          page_size,
          total,
          grade_options,
          cohort_options,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}