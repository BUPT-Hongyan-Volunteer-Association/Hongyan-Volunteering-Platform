import { randomUUID } from 'node:crypto';
import { Controller, Get, Header, Headers, Res } from '@nestjs/common';
import { SessionAccess } from './session.guard.js';
import type { Response } from 'express';
import { SessionService } from './session.service.js';



@Controller('auth')
export class CsrfController {
  constructor(private readonly sessions: SessionService) {}

  @Get('csrf')
  @SessionAccess('anonymous')
  @Header('Cache-Control', 'no-store')
  async getCsrf(@Headers('cookie') cookieHeader: string | undefined,
                @Res({ passthrough: true }) response: Response) {
    const session = await this.sessions.open(cookieHeader, response);
    return {
      data: { csrf_token: session.csrf_token, expires_at: session.expires_at.toISOString() },
      request_id: randomUUID(),
    };
  }
}
