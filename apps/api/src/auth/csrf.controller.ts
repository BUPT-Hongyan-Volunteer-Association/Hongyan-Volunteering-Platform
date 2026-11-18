import { randomUUID } from 'node:crypto';
import { Controller, Get, Header, Headers, Res } from '@nestjs/common';
import { parse } from 'cookie';
import type { Response } from 'express';
import { SessionService } from './session.service.js';

const cookieName = 'volunteer_session';

@Controller('auth')
export class CsrfController {
  constructor(private readonly sessions: SessionService) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  async getCsrf(@Headers('cookie') cookieHeader: string | undefined,
                @Res({ passthrough: true }) response: Response) {
    const { session, newCookie } = await this.sessions.open(parse(cookieHeader ?? '')[cookieName]);
    if (newCookie) {
      response.cookie(cookieName, newCookie, {
        httpOnly: true, secure: true, sameSite: 'lax',
        path: '/api/v1', expires: session.expires_at,
      });
    }
    return {
      data: { csrf_token: session.csrf_token, expires_at: session.expires_at.toISOString() },
      request_id: randomUUID(),
    };
  }
}
