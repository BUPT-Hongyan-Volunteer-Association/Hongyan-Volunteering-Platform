import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { NoticePage, NotificationEventPage, ReceiptPage } from '@hongyan/contracts/types';
import { Database } from '../database.js';
import { BusinessError, denied, envelope, invalid, invisible } from '../http.js';
import { managedScope, pagination, staff } from '../activities/read.js';
import { Workflow, wrongState, type Tx } from '../activities/workflow.js';
import { studentId, type SessionRequest } from '../auth/session.guard.js';
import { Clock } from './clock.js';
import { eventView, noticeView, receiptView } from './notice.js';

const noticeKinds = [
  'result',
  'gathering',
  'change',
  'cancellation',
  'hours_result',
  'appeal_result',
  'other',
];
const receiptStatuses = ['unread', 'read', 'acknowledged'];
const eventStatuses = ['pending', 'running', 'delivered', 'failed', 'superseded'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flag(q: Record<string, string>, name: string) {
  const value = q[name];
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') invalid(name, '只能是 true 或 false');
  return value === 'true';
}

@Controller()
export class NoticeController {
  constructor(
    private db: Database,
    private workflow: Workflow,
    private clock: Clock,
  ) {}

  @Get('me/notices')
  async mine(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    const student = studentId(req.actor);
    const { page, page_size, skip } = pagination(q);
    const unacknowledged = flag(q, 'unacknowledged_only');
    if (q.notice_kind && !noticeKinds.includes(q.notice_kind))
      invalid('notice_kind', '通知类别无效');
    if (q.activity_id && !uuidPattern.test(q.activity_id))
      invalid('activity_id', '活动标识格式错误');
    const where = {
      student_id: student,
      ...(unacknowledged && { acknowledged_at: null }),
      notice: {
        ...(q.notice_kind && { notice_kind: q.notice_kind }),
        ...(q.activity_id && { activity_id: q.activity_id }),
        ...(unacknowledged && { is_current: true, requires_ack: true }),
      },
    };
    const [rows, total] = await Promise.all([
      this.db.noticeReceipt.findMany({
        where,
        include: { notice: true },
        orderBy: [{ notice: { published_at: 'desc' } }, { notice_id: 'asc' }],
        skip,
        take: page_size,
      }),
      this.db.noticeReceipt.count({ where }),
    ]);
    const data: NoticePage = {
      items: rows.map((row) => noticeView(row.notice, row)),
      page,
      page_size,
      total,
    };
    return envelope(data);
  }

  @Post('me/notices/:id/read')
  @HttpCode(200)
  async read(@Req() req: SessionRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const student = studentId(req.actor);
    return this.workflow.run(req, null, 'self', async (tx) => {
      const receipt = await this.lock(tx, id, student);
      if (!receipt) invisible();
      const row = receipt.read_at
        ? receipt
        : await tx.noticeReceipt.update({
            where: { notice_id_student_id: { notice_id: id, student_id: student } },
            data: { read_at: this.clock.now() },
          });
      return noticeView(receipt.notice, row);
    });
  }

  @Post('me/notices/:id/ack')
  @HttpCode(200)
  async acknowledge(@Req() req: SessionRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const student = studentId(req.actor);
    return this.workflow.run(req, null, 'self', async (tx) => {
      const receipt = await this.lock(tx, id, student);
      if (!receipt) invisible();
      if (!receipt.notice.requires_ack)
        throw new BusinessError(409, 'invalid_state', '该通知不需要确认');
      // 重复确认保留首次确认时间，只补写此前缺失的阅读时间。
      const now = this.clock.now();
      const row = receipt.acknowledged_at
        ? receipt
        : await tx.noticeReceipt.update({
            where: { notice_id_student_id: { notice_id: id, student_id: student } },
            data: { acknowledged_at: now, read_at: receipt.read_at ?? now },
          });
      return noticeView(receipt.notice, row);
    });
  }

  @Get('organizer/activities/:id/notices')
  async sent(
    @Req() req: SessionRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: Record<string, string>,
  ) {
    const activity = await this.db.activity.findFirst({
      where: { id, ...managedScope(req.actor) },
      select: { id: true },
    });
    if (!activity) invisible();
    const { page, page_size, skip } = pagination(q);
    const [rows, total] = await Promise.all([
      this.db.notice.findMany({
        where: { activity_id: id },
        include: { _count: { select: { receipts: true } } },
        orderBy: [{ published_at: 'desc' }, { id: 'asc' }],
        skip,
        take: page_size,
      }),
      this.db.notice.count({ where: { activity_id: id } }),
    ]);
    const data: NoticePage = {
      items: rows.map((row) => ({
        ...noticeView(row),
        recipient_count: row._count.receipts,
      })),
      page,
      page_size,
      total,
    };
    return envelope(data);
  }

  @Get('organizer/notices/:id/receipts')
  async receipts(
    @Req() req: SessionRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: Record<string, string>,
  ) {
    const notice = await this.db.notice.findUnique({
      where: { id },
      select: { id: true, activity_id: true, is_current: true, requires_ack: true },
    });
    if (!notice) invisible();
    const activity = await this.db.activity.findFirst({
      where: { id: notice.activity_id, ...managedScope(req.actor) },
      select: { id: true },
    });
    if (!activity) invisible();
    const { page, page_size, skip } = pagination(q);
    const followUp = flag(q, 'follow_up_only');
    if (q.status && !receiptStatuses.includes(q.status)) invalid('status', '回执状态无效');
    // 被替代或无需确认的通知没有待跟进名单，直接返回空页。
    const closed = followUp && (!notice.is_current || !notice.requires_ack);
    const where = {
      notice_id: id,
      ...(q.status === 'unread' && { read_at: null }),
      ...(q.status === 'read' && { read_at: { not: null }, acknowledged_at: null }),
      ...(q.status === 'acknowledged' && { acknowledged_at: { not: null } }),
      ...(followUp &&
        !closed && {
          acknowledged_at: null,
          student: {
            registrations: {
              some: {
                activity_id: notice.activity_id,
                status: { in: ['submitted', 'waitlisted', 'accepted'] },
              },
            },
          },
        }),
      ...(closed && { notice_id: '00000000-0000-0000-0000-000000000000' }),
    };
    const [rows, total] = await Promise.all([
      this.db.noticeReceipt.findMany({
        where,
        include: { student: { select: { student_no: true, account: { select: { display_name: true } } } } },
        orderBy: [{ student: { student_no: 'asc' } }],
        skip,
        take: page_size,
      }),
      this.db.noticeReceipt.count({ where }),
    ]);
    const data: ReceiptPage = {
      items: rows.map((row) => receiptView(row)),
      page,
      page_size,
      total,
    };
    return envelope(data);
  }

  @Get('admin/notification-events')
  async events(@Req() req: SessionRequest, @Query() q: Record<string, string>) {
    if (!staff(req.actor)) denied();
    const { page, page_size, skip } = pagination(q);
    if (q.status && !eventStatuses.includes(q.status)) invalid('status', '事件状态无效');
    if (q.activity_id && !uuidPattern.test(q.activity_id))
      invalid('activity_id', '活动标识格式错误');
    const where = {
      ...(q.status && { status: q.status }),
      ...(q.activity_id && { activity_id: q.activity_id }),
    };
    const [rows, total] = await Promise.all([
      this.db.notificationEvent.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip,
        take: page_size,
      }),
      this.db.notificationEvent.count({ where }),
    ]);
    const data: NotificationEventPage = {
      items: rows.map((row) => eventView(row)),
      page,
      page_size,
      total,
    };
    return envelope(data);
  }

  @Post('admin/notification-events/:id/retry')
  @HttpCode(202)
  async retry(@Req() req: SessionRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.workflow.run(req, null, 'review', async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM notification_event WHERE id = ${id}::uuid FOR UPDATE`;
      const event = await tx.notificationEvent.findUnique({ where: { id } });
      if (!event) invisible();
      if (event.status !== 'failed') wrongState();
      // 复用原事件排队，业务状态不重做；投递时会再次核对公开版本。
      const updated = await tx.notificationEvent.update({
        where: { id },
        data: {
          status: 'pending',
          attempt_count: 0,
          next_retry_at: this.clock.now(),
          last_error: null,
          version: { increment: 1 },
        },
      });
      return eventView(updated);
    });
  }

  // 只操作本人回执时先锁定该行，避免并发确认写入两个不同的首次时间。
  private async lock(tx: Tx, notice_id: string, student_id: string) {
    await tx.$executeRaw`SELECT 1 FROM notice_receipt WHERE notice_id = ${notice_id}::uuid AND student_id = ${student_id}::uuid FOR UPDATE`;
    return tx.noticeReceipt.findUnique({
      where: { notice_id_student_id: { notice_id, student_id } },
      include: { notice: true },
    });
  }
}
