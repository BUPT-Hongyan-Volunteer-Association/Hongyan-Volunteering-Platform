import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  Logger,
  Module,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Response } from 'express';
import { CsrfController } from './auth/csrf.controller.js';
import { SessionService } from './auth/session.service.js';

import { AccountController } from './auth/account.controller.js';
import { SessionGuard, type SessionRequest } from './auth/session.guard.js';
import { BusinessError } from './http.js';
import { ReviewController } from './activities/review.controller.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GroupImageController } from './activities/group-image.js';
import { DraftController } from './activities/draft.controller.js';
import { Workflow } from './activities/workflow.js';
import { Database } from './database.js';
import { PublicController } from './activities/public.controller.js';
import { RecruitmentRequests } from './registrations/requests.controller.js';
import { RegistrationController } from './registrations/registration.controller.js';
import { AttendanceController } from './attendance/attendance.controller.js';
import { ManagedController } from './activities/managed.controller.js';
import { NoticeController } from './notices/notice.controller.js';
import { NoticeWorker } from './notices/notice.worker.js';
import { HourBatchesController, HourUploadScope } from './hours/batches.controller.js';
import { HourValidationWorker } from './hours/validation-worker.js';
import { HourLedgerController } from './hours/ledger.controller.js';
import { HourCorrectionsController } from './hours/corrections.controller.js';
import { HourIncidentsController } from './hours/incidents.controller.js';
import { HourAppealsController } from './hours/appeals.controller.js';
import { StudentController } from './students/student.controller.js';
import { ExportController } from './exports/export.controller.js';
import { ExportService } from './exports/export.service.js';
import { ExportWorker } from './exports/export.worker.js';
import { AuditController } from './audit.controller.js';
import { StudentImportService } from './students/import.service.js';
import { StaffGuard } from './students/staff.guard.js';
import { TimelineController } from './timeline/timeline.controller.js';

@Catch()
class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const request_id = randomUUID();
    if (status === 413) {
      // 契约未定义 413：统一按字段校验失败返回，便于上传页展示。
      response.status(422).set('Cache-Control', 'no-store').json({
        code: 'validation_error',
        message: '文件不得超过 5 MB（5,242,880 字节）',
        details: [
          {
            field: 'file',
            code: 'validation_error',
            message: '文件不得超过 5 MB（5,242,880 字节）',
          },
        ],
        request_id,
      });
      return;
    }
    if (error instanceof BusinessError) {
      response
        .status(status)
        .set('Cache-Control', 'no-store')
        .json({ ...(error.getResponse() as object), request_id });
      return;
    }
    let code = 'internal_error';
    let message = '服务请求失败，请稍后重试';
    if (status >= 500) {
      Logger.error({ request_id, error: error instanceof Error ? error.name : 'UnknownError' });
    } else {
      code = STATUS_CODES[status]?.toLowerCase().replaceAll(' ', '_') ?? 'http_error';
      message = status === 404 ? '接口不存在' : '请求未能处理，请检查请求内容';
    }
    response.status(status).set('Cache-Control', 'no-store').json({ code, message, request_id });
  }
}

@Module({
  controllers: [
    CsrfController,
    AccountController,
    ManagedController,
    PublicController,
    DraftController,
    TimelineController,
    GroupImageController,
    ReviewController,
    RegistrationController,
    RecruitmentRequests,
    AttendanceController,
    NoticeController,
    HourBatchesController,
    HourLedgerController,
    HourCorrectionsController,
    HourIncidentsController,
    HourAppealsController,
    StudentController,
    ExportController,
    AuditController,
  ],
  providers: [
    Database,
    Workflow,
    SessionService,
    SessionGuard,
    StaffGuard,
    HourUploadScope,
    HourValidationWorker,
    StudentImportService,
    ExportService,
    ExportWorker,
    NoticeWorker,
  ],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use((req: SessionRequest, _res: Response, next: NextFunction) => {
    req.receivedAt = new Date();
    next();
  });
  app.useBodyParser('json', {
    limit: '64mb',
    type: req => !!req.headers['content-type']?.startsWith('application/json') && req.method === 'POST' &&
      /^\/api\/v1\/admin\/hour-imports\/[a-f0-9-]+\/decision\/?(?:\?|$)/i.test(req.url ?? ''),
  });
  app.useBodyParser('json', {
    limit: '4mb',
    type: req => !!req.headers['content-type']?.startsWith('application/json') && req.method === 'POST' &&
      /^\/api\/v1\/organizer\/hour-correction-groups\/?(?:\?|$)/i.test(req.url ?? ''),
  });
  app.useBodyParser('json', {
    limit: '7mb',
    type: req => !!req.headers['content-type']?.startsWith('application/json') &&
      /^(POST|PATCH)$/.test(req.method ?? '') &&
      /^\/api\/v1\/organizer\/activities(?:\/[a-f0-9-]+)?\/?(?:\?|$)/i.test(req.url ?? ''),
  });
  app.useBodyParser('json', { limit: '100kb' });
  app.useGlobalGuards(app.get(SessionGuard));
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpErrorFilter());
  return app;
}