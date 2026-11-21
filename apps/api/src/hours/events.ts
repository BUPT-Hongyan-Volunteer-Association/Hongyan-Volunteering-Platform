import { json, type Tx } from '../activities/workflow.js';
import type { NotificationEvent } from '../generated/prisma/client.js';

type HourEventType = 'hours_result' | 'appeal_result' | 'hours_feedback';
type Recipient = { student_id: string; activity_id: string; revision?: number };
type Payload = { student_id: string; actor_id: string; title: string; body: string };

export async function enqueueHourNotices(
  tx: Tx, event_type: HourEventType, resource_id: string, actor_id: string,
  notices: (Recipient & { title: string; body: string })[],
  resourceVersion?: number,
) {
  if (!notices.length) return;
  await tx.notificationEvent.createMany({
    data: notices.map(({ activity_id, revision, ...payload }) => ({
      event_type, resource_id, activity_id, source_revision: revision,
      event_key: [event_type, resource_id, activity_id, payload.student_id,
        ...(resourceVersion !== undefined ? [resourceVersion] : [])].join(':'),
      payload: json({ ...payload, actor_id }),
    })),
    skipDuplicates: true,
  });
}

export function hourNoticeKind(type: string) {
  if (type === 'hours_result' || type === 'appeal_result') return type;
  if (type === 'hours_feedback') return 'other';
}

export async function hourPublication(tx: Tx, event: NotificationEvent, published: number) {
  const payload = event.payload as Payload;
  if (!payload.student_id || !payload.title || !payload.body) return null;
  const allowed = event.event_type !== 'hours_feedback' || !!await tx.student.findFirst({
    where: { id: payload.student_id, account: { active: true,
      roles: { some: { role: 'organizer', OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
      members: { some: { activity_id: event.activity_id! } } },
    },
    select: { id: true },
  });
  return {
    title: payload.title,
    body: payload.body,
    recipients: allowed ? [payload.student_id] : [],
    published_by: payload.actor_id,
    source_revision: event.source_revision ?? published,
  };
}
