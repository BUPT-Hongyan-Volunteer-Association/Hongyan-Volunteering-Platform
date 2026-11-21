import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationEvent } from '../generated/prisma/client.js';
import { Database } from '../database.js';
import { Clock } from './clock.js';
import { changeNoticeBody, changedFields } from './notice.js';

// 失败后按分钟退避：第 1–5 次失败分别等待 1/2/5/15/30 分钟，第 6 次失败转为人工处理。
const retryDelaysMinutes = [1, 2, 5, 15, 30];

type ChangePayload = {
  revision?: number;
  previous_revision?: number;
  changed_fields?: string[];
  recipients?: string[];
  actor_id?: string;
};

type DecisionPayload = {
  registration_id?: string;
  student_id?: string;
  status?: string;
  decision_reason?: string | null;
  actor_id?: string;
};

// 认领版本已被别的消费者推进：说明这条事件已经有人在处理，放弃本次投递，不记失败。
class StaleClaim extends Error {}

const resultTexts: Record<string, string> = {
  accepted: '已被录取',
  waitlisted: '进入候补',
  rejected: '未被录取',
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
    this.timer = setInterval(() => {
      // 整批取数失败（例如数据库瞬时不可用）不该静默：留给下一轮，但要在日志里留痕。
      void this.drain().catch((error: unknown) => {
        this.logger.error(`通知队列本轮取数失败 ${errorText(error)}`);
      });
    }, 5000);
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
    // 返回的 version 就是本次认领的凭据，落库时要用它复核，防止租约过期后重复投递。
    const [claimed] = await this.db.notificationEvent.updateManyAndReturn({
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
      select: { version: true },
    });
    if (!claimed) return;
    const event = await this.db.notificationEvent.findUnique({ where: { id } });
    if (!event) return;
    try {
      await this.deliver(event, now, claimed.version);
    } catch (error) {
      if (error instanceof StaleClaim) {
        this.logger.warn(`通知事件已被其他消费者接管 event=${id} version=${claimed.version}`);
        return;
      }
      this.logger.warn(
        `通知投递失败 event=${id} attempt=${event.attempt_count} ${errorText(error)}`,
      );
      await this.fail(event, error, now, claimed.version);
    }
  }

  // 事件指向的公开版本已被替换时，旧通知没有发送意义，直接作废。
  // 但"被替换"不等于"被覆盖"：后续修订如果没再动这次通知的字段，提醒仍然有效，必须发出去。
  protected async deliver(event: NotificationEvent, now: Date, claimedVersion: number) {
    const activity_id = event.activity_id;
    if (!activity_id) throw new Error('通知事件缺少活动标识');
    await this.db.$transaction(async (tx) => {
      // 锁住活动行：核对公开版本与递增 information_version 必须在同一把锁内完成，
      // 否则并发投递会生成两个相同版本，或对着已被替换的版本发通知。
      await tx.$executeRaw`SELECT id FROM activity WHERE id = ${activity_id}::uuid FOR UPDATE`;
      const activity = await tx.activity.findUnique({
        where: { id: activity_id },
        select: { published_revision: true },
      });

      // 只有认领版本仍属于本次消费者时才落库，避免两个消费者各写一条通知。
      const finish = async (status: 'delivered' | 'superseded') => {
        const done = await tx.notificationEvent.updateMany({
          where: { id: event.id, version: claimedVersion, status: 'running' },
          data: {
            status,
            next_retry_at: null,
            last_error: null,
            ...(status === 'delivered' && { delivered_at: now }),
            // resource_id 保持事件来源（活动变更事件是审核单，录取事件是报名），不改成通知 ID：
            // 重试和追溯时要知道"这条通知是从哪笔业务来的"。
            version: { increment: 1 },
          },
        });
        if (done.count === 0) throw new StaleClaim();
      };

      // 同一个事件重复投递（例如人工把已投递的事件重新排队）只认第一条通知，
      // 唯一键 source_event_id 在数据库层再兜一次底。
      const existing = await tx.notice.findUnique({
        where: { source_event_id: event.id },
        select: { id: true },
      });
      if (existing) {
        await finish('delivered');
        return;
      }

      if (event.event_type === 'activity_changed') {
        if (event.source_revision === null) throw new Error('变更通知缺少修订号');
        const payload = event.payload as ChangePayload;
        if (!activity) {
          await finish('superseded');
          return;
        }
        const previous = await tx.notice.findFirst({
          where: { activity_id, notice_kind: 'change', is_current: true },
          orderBy: { information_version: 'desc' },
        });
        // 提醒按"版本区间"渲染：从学生上次被告知的版本到这次要告知的版本。
        // 迟到的旧事件不能顶掉已送达的更新提醒，所以区间终点取两者中较新的修订；
        // 区间里被后续修订再改过两次的字段，也只会以最终值出现在正文里，不会漏发。
        const target = Math.max(event.source_revision, previous?.source_revision ?? 0);
        // 起点取所有已知区间里最早的那个：迟到的旧事件补发时，提醒要把"从学生上次真正
        // 被告知到现在"的全部变化都算进去，不能只补一条、把另一条挤掉。
        const base = Math.min(
          ...[previous?.base_revision, payload.previous_revision, event.source_revision].filter(
            (value): value is number => typeof value === 'number',
          ),
        );
        const snapshots = await tx.activityRevision.findMany({
          where: { activity_id, revision: { in: [...new Set([base, target])] } },
          select: { revision: true, content: true },
        });
        const baseContent = snapshots.find((row) => row.revision === base)?.content;
        const targetContent = snapshots.find((row) => row.revision === target)?.content;
        // 读不到快照时宁可照发，也不要静默丢掉一条真实变更。
        const fields =
          baseContent === undefined || targetContent === undefined
            ? (payload.changed_fields ?? [])
            : changedFields(baseContent, targetContent);
        if (!fields.length) {
          // 这次变更已经被后续修订的提醒覆盖，单独再发一条只是噪音。
          await finish('superseded');
          return;
        }
        const body = changeNoticeBody(fields, baseContent, targetContent);
        if (previous && previous.body === body) {
          await finish('superseded');
          return;
        }
        const recipients = new Set(payload.recipients ?? []);
        if (previous) {
          // 合并时保留原有接收人：提醒已经送达的人不该因为一条旧事件补发而丢掉回执。
          const kept = await tx.noticeReceipt.findMany({
            where: { notice_id: previous.id },
            select: { student_id: true },
          });
          for (const row of kept) recipients.add(row.student_id);
        }
        // 没有受影响的学生就不生成通知，否则负责人的已发送列表里会多出一条无人接收的空通知。
        if (!recipients.size) {
          await finish('delivered');
          return;
        }
        const title = (targetContent as { title?: string } | null)?.title ?? '活动';
        const notice = await tx.notice.create({
          data: {
            activity_id,
            title: `${title}安排有调整`,
            body,
            requires_ack: true,
            notice_kind: 'change',
            information_version: (previous?.information_version ?? 0) + 1,
            supersedes_id: previous?.id ?? null,
            is_current: true,
            published_by: payload.actor_id ?? null,
            source_event_id: event.id,
            base_revision: base,
            source_revision: target,
            published_at: now,
          },
        });
        if (previous)
          await tx.notice.update({
            where: { id: previous.id },
            data: { is_current: false, version: { increment: 1 } },
          });
        await tx.noticeReceipt.createMany({
          data: [...recipients].map((student_id) => ({ notice_id: notice.id, student_id })),
          skipDuplicates: true,
        });
        await finish('delivered');
        return;
      }

      if (event.event_type === 'registration_decided') {
        const payload = event.payload as DecisionPayload;
        if (!payload.student_id) throw new Error('录取结果通知缺少接收人');
        if (!activity) {
          await finish('superseded');
          return;
        }
        const revision = activity.published_revision
          ? await tx.activityRevision.findUnique({
              where: {
                activity_id_revision: { activity_id, revision: activity.published_revision },
              },
              select: { content: true },
            })
          : null;
        const activityTitle = (revision?.content as { title?: string } | null)?.title ?? '活动';
        const status = payload.status ?? 'accepted';
        const last = await tx.notice.findFirst({
          where: { activity_id, notice_kind: 'result' },
          orderBy: { information_version: 'desc' },
          select: { information_version: true },
        });
        const notice = await tx.notice.create({
          data: {
            activity_id,
            title: `${activityTitle}报名结果`,
            body: resultBody(activityTitle, status, payload.decision_reason ?? null),
            requires_ack: true,
            notice_kind: 'result',
            information_version: (last?.information_version ?? 0) + 1,
            is_current: true,
            published_by: payload.actor_id ?? null,
            source_event_id: event.id,
            source_revision: activity.published_revision,
            published_at: now,
          },
        });
        await tx.noticeReceipt.createMany({
          data: [{ notice_id: notice.id, student_id: payload.student_id }],
          skipDuplicates: true,
        });
        await finish('delivered');
        return;
      }

      throw new Error(`暂不支持的通知事件类型 ${event.event_type}`);
    });
  }

  private async fail(
    event: NotificationEvent,
    error: unknown,
    now: Date,
    claimedVersion: number,
  ) {
    const attempt = event.attempt_count;
    const message = errorText(error).slice(0, 200);
    const delay = retryDelaysMinutes[attempt - 1];
    // 回写也要带认领版本：租约过期后事件可能已被别的消费者投递成功，
    // 旧消费者再按 id 盲写会把 delivered 改回 pending，凭空多出一条通知。
    const written = await this.db.notificationEvent.updateMany({
      where: { id: event.id, version: claimedVersion, status: 'running' },
      data: delay
        ? {
            status: 'pending',
            last_error: message,
            next_retry_at: new Date(now.getTime() + delay * 60_000),
            version: { increment: 1 },
          }
        : { status: 'failed', last_error: message, next_retry_at: null, version: { increment: 1 } },
    });
    if (written.count === 0)
      this.logger.warn(
        `通知事件已被接管，放弃失败回写 event=${event.id} version=${claimedVersion}`,
      );
  }
}

function resultBody(activityTitle: string, status: string, reason: string | null) {
  const result = resultTexts[status] ?? '已有结果';
  const head =
    status === 'accepted'
      ? `恭喜，你${result}：「${activityTitle}」。请按时参加活动，并在活动详情页确认收到通知。`
      : `「${activityTitle}」的报名结果：你${result}。请在活动详情页查看后续安排。`;
  return reason ? `${head}\n说明：${reason}` : head;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
