import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { Catch, HttpException, Logger, Module, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { CsrfController } from './auth/csrf.controller.js';
import { SessionService } from './auth/session.service.js';
import { Database } from './database.js';

import { AccountController } from './auth/account.controller.js';
import { SessionGuard } from './auth/session.guard.js';
import { BusinessError } from './http.js';
import { PublicController } from './activities/public.controller.js';
import { ManagedController } from './activities/managed.controller.js';

@Catch()
class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const request_id = randomUUID();
    if (error instanceof BusinessError) {
      response.status(status).set('Cache-Control','no-store').json({...error.getResponse() as object, request_id});
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

@Module({ controllers: [CsrfController, AccountController, ManagedController, PublicController], providers: [SessionService, SessionGuard, Database] })
class AppModule {}

const app = await NestFactory.create(AppModule);
app.useGlobalGuards(app.get(SessionGuard));
app.setGlobalPrefix('api/v1');
app.useGlobalFilters(new HttpErrorFilter());
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
