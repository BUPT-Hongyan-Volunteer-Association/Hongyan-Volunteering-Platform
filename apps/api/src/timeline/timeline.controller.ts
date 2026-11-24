import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope } from '../http.js';
import { timelinePage } from './timeline.js';

@Controller('timeline')
export class TimelineController {
  constructor(private db: Database) {}
  @Get() async list(
    @Req() req: SessionRequest,
    @Query() q: Record<string, string>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { page, rangeKey } = await timelinePage(this.db, req.actor, q);
    res.setHeader('X-Timeline-Range', rangeKey);
    return envelope(page);
  }
}
