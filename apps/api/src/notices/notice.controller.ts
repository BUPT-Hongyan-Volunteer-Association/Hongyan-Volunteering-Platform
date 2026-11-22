import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type {
  NoticePage,
  NotificationEventPage,
  ReasonAction,
  ReceiptPage,
} from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import { Database } from '../database.js';
import { denied, envelope, invalid, invisible } from '../http.js';
import { managedScope, pagination, staff } from '../activities/read.js';
import { validate } from '../activities/validation.js';
import { Workflow, checkVersion, wrongState } from '../activities/workflow.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { eventView, noticeView, receiptView } from './notice.js';
import { activeStatuses, attendanceKinds, followUpEmpty, receiptStatus, receiptWhere } from './receipts.js';

const noticeKinds = [
  'result',
  'gathering',
  'change',
  'cancellation',
  'hours_result',
  'appeal_result',
  'other',
];
const snapshot = { isolationLevel: 'RepeatableRead' } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Filters = Record<string, string>;

function uuid(q: Filters, field: string) {
  if (q[field] !== undefined && !uuidPattern.test(q[field])) invalid(field, '标识格式错误');
  return q[field];
}

function flag(q: Filters, field: string) {
  const value = q[field];
  if (value !== undefined && value !== 'true' && value !== 'false')
    invalid(field, '只能是 true 或 false');
  return value === 'true';
}

@Controller()
export class NoticeController {
  constructor(
    private db: Database,
    private workflow: Workflow,
  ) {}

  @Get('me/notices')
  async mine(@Req() req: SessionRequest, @Query() q: Filters) {
    const student_id = studentId(req.actor);
    const { page, page_size, skip } = pagination(q);
    const pending = flag(q, 'unacknowledged_only');
    if (q.notice_kind && !noticeKinds.includes(q.notice_kind))
      invalid('notice_kind', '通知类别无效');
    const unread = flag(q, 'unread_only');
    const withCounts = flag(q, 'with_counts');
    if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 100))
      invalid('q', '搜索词最多 100 个字符');
    const text = q.q?.trim().replace(/[\\%_]/g, '\\$&');
    const scope: Prisma.NoticeReceiptWhereInput = {
      student_id,
      notice: {
        id: uuid(q, 'notice_id'),
        activity_id: uuid(q, 'activity_id'),
        notice_kind: q.notice_kind,
        ...(text && {
          OR: [
            { title: { contains: text, mode: 'insensitive' } },
            { body: { contains: text, mode: 'insensitive' } },
          ],
        }),
      },
    };
    const followUp: Prisma.NoticeReceiptWhereInput = {
      acknowledged_at: null,
      notice: {
        is_current: true,
        requires_ack: true,
        OR: [
          { notice_kind: { notIn: attendanceKinds } },
          { activity: { registrations: { some: { student_id, status: { in: activeStatuses } } } } },
        ],
      },
    };
    const where = { ...scope, ...(unread && { read_at: null }), ...(pending && { AND: followUp }) };
    return this.db.$transaction(async (tx) => {
      const rows = await tx.noticeReceipt.findMany({
        where,
        include: { notice: true },
        skip,
        take: page_size,
        orderBy: [{ notice: { published_at: 'desc' } }, { notice_id: 'asc' }],
      });
      const counts = withCounts
        ? {
            all: await tx.noticeReceipt.count({ where: scope }),
            unread: await tx.noticeReceipt.count({ where: { ...scope, read_at: null } }),
            pending: await tx.noticeReceipt.count({ where: { ...scope, AND: followUp } }),
          }
        : undefined;
      const total =
        counts && !(unread && pending)
          ? counts[pending ? 'pending' : unread ? 'unread' : 'all']
          : await tx.noticeReceipt.count({ where });
      return envelope<NoticePage>({
        items: rows.map((r) => noticeView(r.notice, r)),
        page,
        page_size,
        total,
        ...(counts && { inbox_counts: counts }),
      });
    }, snapshot);
  }

  @Post('me/notices/:id/read')
  @HttpCode(200)
  read(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.markReceipt(req, id, false);
  }

  @Post('me/notices/:id/ack')
  @HttpCode(200)
  acknowledge(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.markReceipt(req, id, true);
  }

  private markReceipt(req: SessionRequest, notice_id: string, acknowledge: boolean) {
    const student_id = studentId(req.actor);
    return this.workflow.run(req, null, 'self', async (tx) => {
      // 共享锁将确认与通知替代排序。回执行锁保证两次确认保留同一个首次时间。
      await tx.$queryRaw`SELECT 1 FROM notice n JOIN notice_receipt r ON n.id = r.notice_id
        WHERE n.id = ${notice_id}::uuid AND r.student_id = ${student_id}::uuid FOR SHARE OF n FOR UPDATE OF r`;
      const where = { notice_id_student_id: { notice_id, student_id } };
      const receipt = await tx.noticeReceipt.findUnique({ where, include: { notice: true } });
      if (!receipt) invisible();
      if (acknowledge ? receipt.acknowledged_at : receipt.read_at)
        return noticeView(receipt.notice, receipt);
      if (acknowledge && (!receipt.notice.is_current || !receipt.notice.requires_ack)) wrongState();
      const now = new Date();
      const updated = await tx.noticeReceipt.update({
        where,
        data: { read_at: receipt.read_at ?? now, ...(acknowledge && { acknowledged_at: now }) },
      });
      return noticeView(receipt.notice, updated);
    });
  }

  @Get('organizer/activities/:id/notices')
  async sent(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Filters,
  ) {
    const scope = managedScope(req.actor);
    const { page, page_size, skip } = pagination(q);
    const where = { activity_id: id, id: uuid(q, 'notice_id') };
    return this.db.$transaction(async (tx) => {
      if (!(await tx.activity.findFirst({ where: { id, ...scope }, select: { id: true } })))
        invisible();
      const rows = await tx.notice.findMany({
        where,
        include: { _count: { select: { receipts: true } } },
        orderBy: [{ published_at: 'desc' }, { id: 'asc' }],
        skip,
        take: page_size,
      });
      return envelope<NoticePage>({
        items: rows.map((r) => ({ ...noticeView(r), recipient_count: r._count.receipts })),
        total: await tx.notice.count({ where }),
        page,
        page_size,
      });
    }, snapshot);
  }

  @Get('organizer/notices/:id/receipts')
  async receipts(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: Filters,
  ) {
    const scope = managedScope(req.actor);
    const { page, page_size, skip } = pagination(q);
    const filters = { status: receiptStatus(q.status), follow_up_only: flag(q, 'follow_up_only') };
    return this.db.$transaction(async (tx) => {
      const notice = await tx.notice.findFirst({ where: { id, activity: scope } });
      if (!notice) invisible();
      if (followUpEmpty(notice, filters))
        return envelope<ReceiptPage>({ items: [], total: 0, page, page_size });
      const where = receiptWhere(notice, filters);
      const rows = await tx.noticeReceipt.findMany({
        where,
        include: {
          student: { select: { student_no: true, account: { select: { display_name: true } } } },
        },
        orderBy: { student: { student_no: 'asc' } },
        skip,
        take: page_size,
      });
      return envelope<ReceiptPage>({
        items: rows.map(receiptView),
        page,
        page_size,
        total: await tx.noticeReceipt.count({ where }),
      });
    }, snapshot);
  }

  @Get('admin/notification-events')
  async events(@Req() req: SessionRequest, @Query() q: Filters) {
    if (!staff(req.actor)) denied();
    const { page, page_size, skip } = pagination(q);
    if (q.status && !['pending', 'running', 'delivered', 'failed', 'superseded'].includes(q.status))
      invalid('status', '事件状态无效');
    const where = { status: q.status, activity_id: uuid(q, 'activity_id') };
    const [rows, total] = await this.db.$transaction(
      [
        this.db.notificationEvent.findMany({
          where,
          orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
          skip,
          take: page_size,
        }),
        this.db.notificationEvent.count({ where }),
      ],
      snapshot,
    );
    return envelope<NotificationEventPage>({ items: rows.map(eventView), page, page_size, total });
  }

  @Post('admin/notification-events/:id/retry')
  @HttpCode(202)
  retry(@Req() req: SessionRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.workflow.run(req, null, 'review', async (tx) => {
      const { expected_version, reason } = validate<ReasonAction>('reason_action', body);
      if (!reason.trim()) invalid('reason', '请填写重试原因');
      await tx.$queryRaw`SELECT 1 FROM notification_event WHERE id = ${id}::uuid FOR UPDATE`;
      const event = await tx.notificationEvent.findUnique({ where: { id } });
      if (!event) invisible();
      checkVersion(event.version, expected_version);
      if (event.status !== 'failed') wrongState();
      const updated = await tx.notificationEvent.update({
        where: { id },
        data: {
          status: 'pending',
          attempt_count: 0,
          next_retry_at: null,
          last_error: null,
          last_retry_reason: reason.trim(),
          version: { increment: 1 },
        },
      });
      return eventView(updated);
    });
  }
}