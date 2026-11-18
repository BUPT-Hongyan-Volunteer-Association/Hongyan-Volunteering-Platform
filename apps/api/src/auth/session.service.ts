import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Database } from '../database.js';

const anonymousLifetimeMs = 30 * 60 * 1000;
const hashCookie = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionFields = { csrf_token: true, expires_at: true } as const;

@Injectable()
export class SessionService {
  constructor(private readonly db: Database) {}

  async open(cookieValue?: string) {
    const now = new Date();
    if (cookieValue) {
      const session = await this.db.httpSession.findUnique({
        where: { id_hash: hashCookie(cookieValue), expires_at: { gt: now } },
        select: sessionFields,
      });
      if (session) return { session };
    }

    const newCookie = randomBytes(32).toString('base64url');
    const [, session] = await this.db.$transaction([
      this.db.httpSession.deleteMany({ where: { expires_at: { lte: now } } }),
      this.db.httpSession.create({
        data: {
          id_hash: hashCookie(newCookie),
          csrf_token: randomBytes(32).toString('base64url'),
          expires_at: new Date(now.getTime() + anonymousLifetimeMs),
        },
        select: sessionFields,
      }),
    ]);
    return { session, newCookie };
  }
}
