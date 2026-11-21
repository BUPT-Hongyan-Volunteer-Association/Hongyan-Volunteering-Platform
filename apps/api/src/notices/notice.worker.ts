import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ActivityInput } from '@hongyan/contracts/types';
import type { Notice, NotificationEvent } from '../generated/prisma/client.js';
import type { Tx } from '../activities/workflow.js';
import { Database } from '../database.js';
import { changeNoticeBody } from './notice.js';

// 失败后按分钟退避：第 1–5 次失败分别等待 1/2/5/15/30 分钟，第 6 次失败转为人工处理。
const retryDelaysMinutes = [1, 2, 5, 15, 30];

type DecisionPayload = {
  student_id: string;
  status: string;
  decision_reason?: string | null;
  actor_id?: string;
};

type Publication = {
  title: string;
  body: string;
  recipients: string[];
  published_by: string | null;
  source_revision: number;
  base_revision?: number;
};

// 认领版本已被别的消费者推进：说明这条事件已经有人在处理，放弃本次投递，不记失败。
class StaleClaim extends Error {}
class DeliveryError extends Error {}

function dueAt(now: Date) {
  return {
    status: { in: ['pending', 'running'] },
    OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
  };
}

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

  constructor(private db: Database) {}

  onModuleInit() {
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
  async drain(now = new Date()) {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.db.notificationEvent.findMany({
        where: dueAt(now),
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
    // 租约到期可重新认领，完成与失败回写均按本次返回的版本匹配。
    const [event] = await this.db.notificationEvent.updateManyAndReturn({
      where: { id, ...dueAt(now) },
      data: {
        status: 'running',
        attempt_count: { increment: 1 },
        version: { increment: 1 },
        next_retry_at: new Date(now.getTime() + 60_000),
      },
    });
    if (!event) return;
    try {
      await this.deliver(event, now);
    } catch (error) {
      if (error instanceof StaleClaim) {
        this.logger.warn(`通知事件已被其他消费者接管 event=${id} version=${event.version}`);
        return;
      }
      this.logger.warn(
        `通知投递失败 event=${id} attempt=${event.attempt_count} ${errorText(error)}`,
      );
      await this.fail(event, error, now);
    }
  }

  protected async deliver(event: NotificationEvent, now: Date) {
    const { activity_id } = event;
    if (!activity_id) throw new DeliveryError('通知事件缺少活动标识');
    await this.db.$transaction(async (tx) => {
      // 审批与投递共用活动锁，版本号和当前通知随回执一起提交。
      const [activity] = await tx.$queryRaw<{ published_revision: number | null }[]>`
        SELECT published_revision FROM activity WHERE id = ${activity_id}::uuid FOR UPDATE`;
      const existing = await tx.notice.findUnique({
        where: { source_event_id: event.id },
        select: { id: true },
      });
      let status = 'delivered';
      if (!existing) {
        status = activity?.published_revision
          ? await this.publish(tx, event, activity_id, activity.published_revision, now)
          : 'superseded';
      }
      const done = await tx.notificationEvent.updateMany({
        where: { id: event.id, version: event.version, status: 'running' },
        data: {
          status,
          next_retry_at: null,
          last_error: null,
          version: { increment: 1 },
          ...(status === 'delivered' && { delivered_at: now }),
        },
      });
      if (!done.count) throw new StaleClaim();
    });
  }

  private async publish(
    tx: Tx,
    event: NotificationEvent,
    activity_id: string,
    published: number,
    now: Date,
  ) {
    const change = event.event_type === 'activity_changed';
    if (!change && event.event_type !== 'registration_decided')
      throw new DeliveryError('未知的通知事件类型');
    const notice_kind = change ? 'change' : 'result';
    const previous = await tx.notice.findFirst({
      where: { activity_id, notice_kind },
      orderBy: { information_version: 'desc' },
    });
    const publication = change
      ? await changePublication(tx, event, activity_id, published, previous)
      : await resultPublication(tx, event, activity_id, published);
    if (!publication) return 'superseded';

    if (change && previous?.is_current) {
      await tx.notice.update({
        where: { id: previous.id },
        data: { is_current: false, version: { increment: 1 } },
      });
    }
    const { recipients, ...content } = publication;
    if (recipients.length) {
      await tx.notice.create({
        data: {
          ...content,
          activity_id,
          notice_kind,
          source_event_id: event.id,
          published_at: now,
          information_version: (previous?.information_version ?? 0) + 1,
          ...(change && previous && { supersedes_id: previous.id }),
          receipts: { createMany: { data: recipients.map((student_id) => ({ student_id })) } },
        },
      });
    }
    return 'delivered';
  }

  private async fail(event: NotificationEvent, error: unknown, now: Date) {
    const attempt = event.attempt_count;
    const message =
      error instanceof DeliveryError ? error.message : '投递失败，请按事件 ID 查阅服务日志';
    const delay = retryDelaysMinutes[attempt - 1];
    // 回写也要带认领版本：租约过期后事件可能已被别的消费者投递成功，
    // 旧消费者再按 id 盲写会把 delivered 改回 pending，凭空多出一条通知。
    const written = await this.db.notificationEvent.updateMany({
      where: { id: event.id, version: event.version, status: 'running' },
      data: {
        status: delay ? 'pending' : 'failed',
        last_error: message,
        next_retry_at: delay ? new Date(now.getTime() + delay * 60_000) : null,
        version: { increment: 1 },
      },
    });
    if (written.count === 0)
      this.logger.warn(`通知事件已被接管，放弃失败回写 event=${event.id} version=${event.version}`);
  }
}

async function changePublication(
  tx: Tx,
  event: NotificationEvent,
  activity_id: string,
  published: number,
  previous: Notice | null,
): Promise<Publication | null> {
  const revision = event.source_revision;
  if (revision === null) throw new DeliveryError('变更通知缺少审核来源');
  const newer = await tx.notificationEvent.findFirst({
    where: {
      activity_id,
      event_type: 'activity_changed',
      source_revision: { gt: revision, lte: published },
    },
    select: { id: true },
  });
  // 较新的事件负责合并仍有效的字段。旧事件迟到时不替换已送达的通知或重置确认。
  if (revision > published || newer || (previous?.source_revision ?? 0) >= revision) return null;
  const review = await tx.activityReview.findUniqueOrThrow({ where: { id: event.resource_id } });
  if (review.previous_revision === null) throw new DeliveryError('变更审核缺少前一公开版本');
  const audience = await tx.activityChangeEvent.findMany({
    where: { review_id: review.id },
    select: { student_id: true },
  });
  const recipients = audience.map((row) => row.student_id);
  let base = review.previous_revision;
  if (recipients.length) {
    const current = previous?.is_current ? previous : null;
    if (
      current?.base_revision != null &&
      (await tx.noticeReceipt.findFirst({
        where: { notice_id: current.id, student_id: { in: recipients }, acknowledged_at: null },
        select: { notice_id: true },
      }))
    ) {
      base = current.base_revision;
    } else {
      // 从本批接收人最早尚未送达的变更开始。审批时冻结的名单保存在 activity_change_event。
      const first = await tx.activityChangeEvent.findFirst({
        where: {
          activity_id,
          student_id: { in: recipients },
          revision: { gt: previous?.source_revision ?? 0, lt: revision },
        },
        orderBy: { revision: 'asc' },
        select: { review_id: true },
      });
      if (first) {
        const start = await tx.activityReview.findUniqueOrThrow({ where: { id: first.review_id } });
        base = start.previous_revision ?? base;
      }
    }
  }
  const versions = await tx.activityRevision.findMany({
    where: { activity_id, revision_state: 'approved', revision: { gte: base, lte: revision } },
    orderBy: { revision: 'asc' },
    select: { revision: true, content: true },
  });
  if (versions[0]?.revision !== base || versions.at(-1)?.revision !== revision)
    throw new DeliveryError('缺少已批准的活动修订快照');
  const contents = versions.map((row) => row.content as unknown as ActivityInput);
  return {
    title: `${contents[contents.length - 1].title}安排有调整`,
    body: changeNoticeBody(contents),
    recipients,
    published_by: review.reviewed_by,
    base_revision: base,
    source_revision: revision,
  };
}

async function resultPublication(
  tx: Tx,
  event: NotificationEvent,
  activity_id: string,
  published: number,
): Promise<Publication> {
  const payload = event.payload as DecisionPayload;
  if (!payload.student_id || !payload.status)
    throw new DeliveryError('录取结果缺少接收人或决定状态');
  const revision = await tx.activityRevision.findUniqueOrThrow({
    where: { activity_id_revision: { activity_id, revision: published } },
    select: { content: true },
  });
  const { title } = revision.content as unknown as ActivityInput;
  return {
    title: `${title}报名结果`,
    body: resultBody(title, payload.status, payload.decision_reason ?? null),
    recipients: [payload.student_id],
    published_by: payload.actor_id ?? null,
    source_revision: published,
  };
}

function resultBody(activityTitle: string, status: string, reason: string | null) {
  const result = resultTexts[status] ?? '已有结果';
  const head =
    status === 'accepted'
      ? `恭喜，你${result}：「${activityTitle}」。请按时参加活动，并在通知详情页确认收到。`
      : `「${activityTitle}」的报名结果：你${result}。请在活动详情页查看后续安排。`;
  return reason ? `${head}\n说明：${reason}` : head;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
