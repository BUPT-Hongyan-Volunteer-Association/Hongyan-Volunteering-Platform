import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationEvent } from '../generated/prisma/client.js';
import { Database } from '../database.js';
import { Clock } from './clock.js';
import { changeNoticeBody } from './notice.js';

// 失败后按分钟退避：第 1–5 次失败分别等待 1/2/5/15/30 分钟，第 6 次失败转为人工处理。
const retryDelaysMinutes = [1, 2, 5, 15, 30];

type ChangePayload = {
  revision?: number;
  previous_revision?: number;
  changed_fields?: string[];
  recipients?: string[];
  actor_id?: string;
};

@Injectable()
export class NoticeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NoticeWorker.name);
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
      for (const { id } of due) {
        // 单个事件处理失败（例如数据库瞬时错误）不能拖垮整批，下一轮会重新取到它。
        try {
          await this.attempt(id, now);
        } catch (error) {
          this.logger.error(`通知事件处理异常 event=${id} ${errorText(error)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async attempt(id: string, now: Date) {
    // 抢占成功的同时写入 1 分钟租约：多实例部署时，别的进程不会在同一时刻把
    // 这条事件再认领一次；进程崩溃后租约到期，事件会自动回到队列。
    const claimed = await this.db.notificationEvent.updateMany({
      where: {
        id,
        status: { in: ['pending', 'running'] },
        OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
      },
      data: {
        status: 'running',
        attempt_count: { increment: 1 },
        version: { increment: 1 },
        next_retry_at: new Date(now.getTime() + 60_000),
      },
    });
    if (claimed.count === 0) return;
    const event = await this.db.notificationEvent.findUnique({ where: { id } });
    if (!event) return;
    try {
      await this.deliver(event, now);
    } catch (error) {
      this.logger.warn(
        `通知投递失败 event=${id} attempt=${event.attempt_count} ${errorText(error)}`,
      );
      await this.fail(event, error, now);
    }
  }

  // 事件指向的公开版本已被替换时，旧通知没有发送意义，直接作废。
  protected async deliver(event: NotificationEvent, now: Date) {
    const activity_id = event.activity_id;
    if (!activity_id) throw new Error('通知事件缺少活动标识');
    if (event.event_type !== 'activity_changed' || event.source_revision === null)
      throw new Error(`暂不支持的通知事件类型 ${event.event_type}`);
    const payload = event.payload as ChangePayload;
    await this.db.$transaction(async (tx) => {
      // 锁住活动行：核对公开版本与递增 information_version 必须在同一把锁内完成，
      // 否则并发投递会生成两个相同版本，或对着已被替换的版本发通知。
      await tx.$executeRaw`SELECT id FROM activity WHERE id = ${activity_id}::uuid FOR UPDATE`;
      const activity = await tx.activity.findUnique({
        where: { id: activity_id },
        select: { published_revision: true },
      });
      if (!activity || activity.published_revision !== event.source_revision) {
        await tx.notificationEvent.update({
          where: { id: event.id },
          data: { status: 'superseded', next_retry_at: null, version: { increment: 1 } },
        });
        return;
      }
      const recipients = [...new Set(payload.recipients ?? [])];
      // 没有受影响的学生就不生成通知，否则负责人的已发送列表里会多出一条无人接收的空通知。
      if (!recipients.length) {
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
        return;
      }
      const previous = await tx.notice.findFirst({
        where: { activity_id, notice_kind: 'change', is_current: true },
        orderBy: { information_version: 'desc' },
      });
      const [revision, before] = await Promise.all([
        tx.activityRevision.findUnique({
          where: {
            activity_id_revision: { activity_id, revision: event.source_revision! },
          },
          select: { content: true },
        }),
        payload.previous_revision
          ? tx.activityRevision.findUnique({
              where: {
                activity_id_revision: {
                  activity_id,
                  revision: payload.previous_revision,
                },
              },
              select: { content: true },
            })
          : null,
      ]);
      const title = (revision?.content as { title?: string } | null)?.title ?? '活动';
      const notice = await tx.notice.create({
        data: {
          activity_id,
          title: `${title}安排有调整`,
          body: changeNoticeBody(payload.changed_fields ?? [], before?.content, revision?.content),
          requires_ack: true,
          notice_kind: 'change',
          information_version: (previous?.information_version ?? 0) + 1,
          supersedes_id: previous?.id ?? null,
          is_current: true,
          published_by: payload.actor_id ?? null,
          published_at: now,
        },
      });
      if (previous)
        await tx.notice.update({
          where: { id: previous.id },
          data: { is_current: false, version: { increment: 1 } },
        });
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
    const message = errorText(error).slice(0, 200);
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
