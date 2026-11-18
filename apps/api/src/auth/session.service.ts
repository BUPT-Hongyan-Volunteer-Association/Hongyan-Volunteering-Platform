import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { parse } from 'cookie';
import type { Response } from 'express';
import { Database } from '../database.js';

const cookieName = 'volunteer_session';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1' } as const;
export function clearCookie(res: Response) {
  res.clearCookie(cookieName, cookieOptions);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const cookieHash = (header?: string) => hash(parse(header ?? '')[cookieName] ?? '');

export function issueSession(account_id?: string) {
  const value = randomBytes(32).toString('base64url');
  return {
    value,
    data: {
      id_hash: hash(value),
      account_id,
      csrf_token: randomBytes(32).toString('base64url'),
      expires_at: new Date(Date.now() + 30 * 60_000),
    },
  };
}
export function setCookie(res: Response, issued: ReturnType<typeof issueSession>) {
  res.cookie(cookieName, issued.value, { ...cookieOptions, expires: issued.data.expires_at });
}

@Injectable()
export class SessionService {
  constructor(private readonly db: Database) {}
  async open(header: string | undefined, res: Response) {
    const session = await this.db.httpSession.findUnique({
      where: { id_hash: cookieHash(header), expires_at: { gt: new Date() } },
      select: { csrf_token: true, expires_at: true },
    });
    if (session) return session;
    const issued = issueSession();
    await this.db.$transaction([
      this.db.httpSession.deleteMany({ where: { expires_at: { lte: new Date() } } }),
      this.db.httpSession.create({ data: issued.data }),
    ]);
    setCookie(res, issued);
    return issued.data;
  }
}
