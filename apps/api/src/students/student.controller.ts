import type { StudentPatch } from '@hongyan/contracts/types';
import { Workflow, type Tx } from '../activities/workflow.js';
import { managedAccountScope } from '../auth/account-access.js';
import type { Actor } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { updateStudent } from './student-profile.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { validate } from '../activities/validation.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { denied, envelope, invisible } from '../http.js';
import { maxImportBytes } from './import.js';
import { StudentImportService, type UploadedStudentFile } from './import.service.js';
import { StaffGuard } from './staff.guard.js';

@Controller()
@UseGuards(StaffGuard)
export class StudentController {
  constructor(private readonly imports: StudentImportService, private readonly db: Database, private readonly workflow: Workflow) {}

  @Post('admin/student-imports')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: maxImportBytes + 1024 * 1024, fields: 4 } }),
  )
  upload(@Req() req: SessionRequest, @UploadedFile() file: UploadedStudentFile | undefined) {
    return this.imports.create(req, file);
  }

  @Get('admin/student-imports/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.imports.get(id));
  }

  @Get('admin/student-imports/:id/rows')
  async rows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string>,
  ) {
    return envelope(await this.imports.rows(id, query));
  }

  @Post('admin/student-imports/:id/commit')
  @HttpCode(200)
  commit(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = validate<{ expected_version: number; source_hash: string }>(
      'hour_batch_submit',
      body,
    );
    return this.imports.commit(req, id, input);
  }

  @Post('admin/student-imports/:id/retry')
  @HttpCode(202)
  retry(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = validate<{ expected_version: number }>('version_action', body);
    return this.imports.retry(req, id, input);
  }

  @Patch('admin/students/:id')
  async update(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const target = await this.db.student.findUnique({ where: { id }, select: { account_id: true } });
    if (!target) return req.actor.roles.includes('tech_admin') ? invisible() : denied();
    const checkAccess = async (tx: Tx, actor: Actor) => {
      const allowed = await tx.account.count({ where: { ...managedAccountScope(actor), id: target.account_id, student: { id } } });
      if (!allowed) denied();
    };
    return this.workflow.run(req, { accountId: target.account_id, checkAccess }, 'review', (tx, _activity, actor) =>
      updateStudent(tx, id, actor, validate<StudentPatch>('student_patch', body)));
  }

  @Get('admin/students')
  async students(@Query() query: Record<string, string>) {
    return envelope(await this.imports.students(query));
  }
}