import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { pagination } from '../activities/read.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import { envelope } from '../http.js';
import { hourLedgerFilters, readHourLedger, type HourLedgerScope } from './read-ledger.js';

type QueryValues = Record<string, string>;

@Controller()
export class HourLedgerController {
  constructor(private db: Database) {}

  @Get('me/hours')
  mine(@Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.read(req, query, { type: 'my_hours' });
  }

  @Get('organizer/activities/:id/hours')
  activity(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.read(req, query, { type: 'activity_hours', activity_id: id });
  }

  @Get('admin/students/:id/hours')
  student(@Param('id', ParseUUIDPipe) id: string, @Req() req: SessionRequest, @Query() query: QueryValues) {
    return this.read(req, query, { type: 'admin_student_hours', student_id: id });
  }

  private async read(req: SessionRequest, query: QueryValues, scope: HourLedgerScope) {
    const page = pagination(query);
    const result = await this.db.$transaction(
      (tx) => readHourLedger(tx, req.actor, scope, hourLedgerFilters(query), page), { isolationLevel: 'RepeatableRead' },
    );
    return envelope({ ...result, page: page.page, page_size: page.page_size });
  }
}
