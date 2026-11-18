import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Catch, HttpException, Logger, Module, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { CsrfController } from './auth/csrf.controller.js';
import { SessionService } from './auth/session.service.js';
import { Database } from './database.js';

@Catch()
class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const request_id = randomUUID();
    if (status >= 500) {
      Logger.error({ request_id, error: error instanceof Error ? error.name : 'UnknownError' });
    }
    response.status(status).set('Cache-Control', 'no-store').json({
      code: status === 404 ? 'not_found' : 'internal_error',
      message: status === 404 ? '接口不存在' : '服务请求失败，请稍后重试',
      request_id,
    });
  }
}

@Module({ controllers: [CsrfController], providers: [SessionService, Database] })
class AppModule {}

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api/v1');
app.useGlobalFilters(new HttpErrorFilter());
app.enableShutdownHooks();
await app.listen(3000, '127.0.0.1');
