import type {
  ActivityInput,
  Registration as View,
  RegistrationDecision,
  RegistrationInput,
} from '@hongyan/contracts/types';
import type { Registration } from '../generated/prisma/client.js';
import { slots } from '../activities/schedule.js';
import { publishedRevision, type LoadedActivity } from '../activities/read.js';
import { checkVersion, wrongState, type Tx } from '../activities/workflow.js';
import { BusinessError, invalid, invisible } from '../http.js';

function approvedContent(activity: LoadedActivity) {
  const revision = publishedRevision(activity);
  return revision?.content as unknown as ActivityInput | undefined;
}

export function registrationView(row: Registration): View {
  return {
    id: row.id,
    activity_id: row.activity_id,
    student_id: row.student_id,
    version: row.version,
    status: row.status as View['status'],
    submitted_at: row.submitted_at.toISOString(),
    ...(row.statement !== null && { statement: row.statement }),
    ...(row.decision_reason !== null && { decision_reason: row.decision_reason }),
  };
}

function history(row: Registration, changed_at: Date | null, actor_id: string | null) {
  return {
    registration_id: row.id,
    version: row.version,
    status: row.status,
    submitted_at: row.submitted_at,
    statement: row.statement,
    decision_reason: row.decision_reason,
    changed_at,
    actor_id,
  };
}

async function recordChange(
  tx: Tx,
  previous: Registration | null,
  current: Registration,
  time: Date,
  actor: string,
) {
  // An imported or seeded relation may predate version history. Preserve the facts it actually has.
  if (previous)
    await tx.registrationHistory.createMany({
      data: [
        history(previous, previous.status === 'submitted' ? previous.submitted_at : null, null),
      ],
      skipDuplicates: true,
    });
  await tx.registrationHistory.create({ data: history(current, time, actor) });
}

export async function apply(
  tx: Tx,
  activity: LoadedActivity,
  student_id: string,
  actor: string,
  received: Date,
  input: RegistrationInput,
) {
  const approved = approvedContent(activity);
  if (!approved) invisible();
  if (activity.status !== 'published') wrongState();
  const opens = Date.parse(approved.registration_opens_at);
  const closes = Date.parse(approved.registration_closes_at);
  if (!(opens < closes)) wrongState();
  if (received.getTime() < opens)
    throw new BusinessError(409, 'registration_not_open', '尚未到报名开放时间');
  if (received.getTime() >= closes)
    throw new BusinessError(409, 'registration_closed', '报名已截止');
  const relation = { activity_id: activity.id, student_id };
  const previous = await tx.registration.findUnique({
    where: { activity_id_student_id: relation },
  });
  if (previous && previous.status !== 'withdrawn') {
    if (['submitted', 'waitlisted', 'accepted'].includes(previous.status))
      return registrationView(previous);
    wrongState();
  }
  const data = {
    status: 'submitted',
    submitted_at: received,
    statement: input.statement ?? null,
    decision_reason: null,
  };
  const current = previous
    ? await tx.registration.update({
        where: { id: previous.id },
        data: { ...data, version: { increment: 1 } },
      })
    : await tx.registration.create({ data: { ...relation, ...data } });
  await recordChange(tx, previous, current, received, actor);
  return registrationView(current);
}

export async function admit(
  tx: Tx,
  activity: LoadedActivity,
  id: string,
  actor: string,
  input: RegistrationDecision,
) {
  if (input.decision !== 'accepted') invalid('decision', '本批仅开放单人录取');
  const previous = await tx.registration.findUnique({ where: { id, activity_id: activity.id } });
  if (!previous) invisible();
  checkVersion(previous.version, input.expected_version);
  if (
    !['submitted', 'waitlisted', 'rejected'].includes(previous.status) ||
    activity.status !== 'published'
  )
    wrongState();
  // Account activation and the admission must have an unambiguous order.
  const [student] = await tx.$queryRaw<{ active: boolean }[]>`SELECT a.active FROM account a
    JOIN student s ON s.account_id = a.id WHERE s.id = ${previous.student_id}::uuid FOR SHARE OF a, s`;
  if (!student?.active) throw new BusinessError(409, 'invalid_state', '学生已停用，无法录取');
  const approved = approvedContent(activity);
  const now = new Date();
  if (!approved || !slots(approved.schedule).some((s) => Date.parse(s.starts_at) > now.getTime()))
    throw new BusinessError(409, 'invalid_state', '所有获批时段均已开始，无法录取');
  const occupied = await tx.registration.count({
    where: { activity_id: activity.id, status: 'accepted' },
  });
  if (!(occupied < approved.capacity))
    throw new BusinessError(409, 'capacity_conflict', '剩余名额已被其他录取操作占用，请刷新名单。');
  const current = await tx.registration.update({
    where: { id },
    data: { status: 'accepted', version: { increment: 1 }, decision_reason: input.reason ?? null },
  });
  await recordChange(tx, previous, current, now, actor);
  const decision = await tx.registrationDecisionEvent.create({
    data: {
      activity_id: activity.id,
      registration_id: id,
      student_id: current.student_id,
      registration_version: current.version,
      status: current.status,
    },
  });
  // 决定与待发送通知写在同一个事务里：要么都成立，要么都不成立，不会出现"录取了却没通知"。
  // 队列条目直接沿用决定事件的 ID：重试、追溯、幂等判断都对着同一笔业务事实，
  // 不会出现"队列里一个新 ID、库里一个旧 ID"对不上的情况。
  await tx.notificationEvent.createMany({
    data: [
      {
        id: decision.event_id,
        event_type: 'registration_decided',
        event_key: `registration_decision:${decision.event_id}`,
        activity_id: activity.id,
        resource_id: id,
        payload: {
          event_id: decision.event_id,
          registration_id: id,
          student_id: current.student_id,
          registration_version: current.version,
          status: current.status,
          decision_reason: current.decision_reason,
          actor_id: actor,
        },
      },
    ],
    skipDuplicates: true,
  });
  return registrationView(current);
}
