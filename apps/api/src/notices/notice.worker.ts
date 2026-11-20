import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationEvent } from '../generated/prisma/client.js';
import { Database } from '../database.js';
import { Clock } from './clock.js';
import { changeNoticeBody } from './notice.js';

// 失败后按分钟退避：第 1–5 次失败分别等待 1/2/5/15/30 分钟，第 6 次失败转为人工处理。
const retryDelaysMinutes = [1, 2, 5, 15, 30];

type ChangePayload = {
  revision?: number;
  changed_fields?: string[];
  recipients?: string[];
};

@Injectable()
export class NoticeWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private db: Database,
    private clock: Clock,
  ) {}

  onModuleInit() {
    // 单进程测试由用例自行驱动 drain()，不需要后台定时器。
    if (process.env.NOTICE_WORKER === 'off') return;
    this.timer = setInterval(() => void this.drain().catch(() => undefined), 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // 取一批到期事件逐个投递。抢占失败的（已被别的进程处理）直接跳过。
  async drain(now = this.clock.now()) {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.db.notificationEvent.findMany({
        where: {
          status: { in: ['pending', 'running'] },
          OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: 50,
      });
      for (const { id } of due) await this.attempt(id, now);
    } finally {
      this.draining = false;
    }
  }

  private async attempt(id: string, now: Date) {
    const claimed = await this.db.notificationEvent.updateMany({
      where: {
        id,
        status: { in: ['pending', 'running'] },
        OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
      },
      data: { status: 'running', attempt_count: { increment: 1 }, version: { increment: 1 } },
    });
    if (claimed.count === 0) return;
    const event = await this.db.notificationEvent.findUnique({ where: { id } });
    if (!event) return;
    try {
      await this.deliver(event, now);
    } catch (error) {
      Logger.warn({ event_id: id, error: error instanceof Error ? error.message : 'unknown' });
      await this.fail(event, error, now);
    }
  }

  // 事件指向的公开版本已被替换时，旧通知没有发送意义，直接作废。
  protected async deliver(event: NotificationEvent, now: Date) {
    if (!event.activity_id) throw new Error('通知事件缺少活动标识');
    const activity = await this.db.activity.findUnique({
      where: { id: event.activity_id },
      select: { published_revision: true },
    });
    if (!activity || activity.published_revision !== event.source_revision) {
      await this.db.notificationEvent.update({
        where: { id: event.id },
        data: { status: 'superseded', next_retry_at: null, version: { increment: 1 } },
      });
      return;
    }
    const payload = event.payload as ChangePayload;
    await this.db.$transaction(async (tx) => {
      const previous = await tx.notice.findFirst({
        where: { activity_id: event.activity_id!, notice_kind: 'change', is_current: true },
        orderBy: { information_version: 'desc' },
      });
      const revision = await tx.activityRevision.findUnique({
        where: {
          activity_id_revision: { activity_id: event.activity_id!, revision: event.source_revision! },
        },
        select: { content: true },
      });
      const title = (revision?.content as { title?: string } | null)?.title ?? '活动';
      const notice = await tx.notice.create({
        data: {
          activity_id: event.activity_id!,
          title: `${title}安排有调整`,
          body: changeNoticeBody(title, payload.changed_fields ?? []),
          requires_ack: true,
          notice_kind: 'change',
          information_version: (previous?.information_version ?? 0) + 1,
          supersedes_id: previous?.id ?? null,
          is_current: true,
          published_at: now,
        },
      });
      if (previous)
        await tx.notice.update({
          where: { id: previous.id },
          data: { is_current: false, version: { increment: 1 } },
        });
      const recipients = [...new Set(payload.recipients ?? [])];
      if (recipients.length)
        await tx.noticeReceipt.createMany({
          data: recipients.map((student_id) => ({ notice_id: notice.id, student_id })),
          skipDuplicates: true,
        });
      await tx.notificationEvent.update({
        where: { id: event.id },
        data: {
          status: 'delivered',
          delivered_at: now,
          next_retry_at: null,
          last_error: null,
          version: { increment: 1 },
        },
      });
    });
  }

  private async fail(event: NotificationEvent, error: unknown, now: Date) {
    const attempt = event.attempt_count;
    const message = (error instanceof Error ? error.message : '通知投递失败').slice(0, 200);
    const delay = retryDelaysMinutes[attempt - 1];
    await this.db.notificationEvent.update({
      where: { id: event.id },
      data: delay
        ? {
            status: 'pending',
            last_error: message,
            next_retry_at: new Date(now.getTime() + delay * 60_000),
            version: { increment: 1 },
          }
        : { status: 'failed', last_error: message, next_retry_at: null, version: { increment: 1 } },
    });
  }
}
