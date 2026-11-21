import { Controller, Get, Query, Req } from '@nestjs/common';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope } from '../http.js';
import { timelinePage } from './timeline.js';

@Controller('timeline')
export class TimelineController {
  constructor(private db: Database) {}
  @Get() async list(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    return envelope(await timelinePage(this.db, req.actor, q));
  }
}
