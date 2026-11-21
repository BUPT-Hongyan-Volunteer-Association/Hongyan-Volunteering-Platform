import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { envelope } from '../http.js';
import { maxImportBytes } from './import.js';
import { StudentImportService, type UploadedStudentFile } from './import.service.js';
import { StaffGuard } from './staff.guard.js';

@Controller()
@UseGuards(StaffGuard)
export class StudentController {
  constructor(private readonly imports: StudentImportService) {}

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

  @Get('admin/students')
  async students(@Query() query: Record<string, string>) {
    return envelope(await this.imports.students(query));
  }
}