import { canChangeRegistration } from '@hongyan/contracts/activity';
import { audit } from '../audit.js';
import type {
  ActivityPublicationContent,
  Registration as View,
  BulkRegistrationDecision,
  RegistrationInput,
} from '@hongyan/contracts/types';
import type { Prisma, Registration } from '../generated/prisma/client.js';
import { occurrences } from '../activities/schedule.js';
import { publishedRevision, type LoadedActivity } from '../activities/read.js';
import { wrongState, BusinessError, invalid, invisible } from '../http.js';
import { type Tx } from '../database.js';

export const rosterOrderBy = [
  { submitted_at: 'asc' },
  { id: 'asc' },
] satisfies Prisma.RegistrationOrderByWithRelationInput[];

/** 名单页面和导出共用的搜索条件；状态过滤由调用方决定是否叠加。 */
export function rosterSearchWhere(filters: {
  activity_id: string;
  q?: string;
  registration_ids?: string[];
}): Prisma.RegistrationWhereInput {
  const search = filters.q?.trim();
  return {
    activity_id: filters.activity_id,
    ...(filters.registration_ids && { id: { in: filters.registration_ids } }),
    ...(search && {
      student: {
        OR: [{ student_no: { contains: search } }, { account: { display_name: { contains: search } } }],
      },
    }),
  };
}

export function rosterWhere(filters: {
  activity_id: string;
  q?: string;
  registration_ids?: string[];
  status?: string;
}): Prisma.RegistrationWhereInput {
  return {
    ...rosterSearchWhere(filters),
    ...(filters.status && { status: filters.status }),
  };
}

export function approvedContent(activity: LoadedActivity) {
  const revision = publishedRevision(activity);
  return revision?.content as unknown as ActivityPublicationContent | undefined;
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

export async function recordChanges(
  tx: Tx, previous: Registration[], current: Registration[], time: Date, actor: string,
) {
  // 决定与投递共用活动锁。保留已发送通知和回执，关闭旧报名版本的确认。
  const previousIds = previous.filter(r => ['accepted', 'waitlisted', 'rejected'].includes(r.status)).map(r => r.id);
  if (previousIds.length) await tx.$executeRaw`
    UPDATE notice n SET is_current = false, version = n.version + 1, updated_at = CURRENT_TIMESTAMP
    FROM notification_event e WHERE n.source_event_id = e.id AND n.is_current
      AND e.event_type = 'registration_decided' AND e.resource_id = ANY(${previousIds}::uuid[])`;
  await tx.registrationHistory.createMany({ data: current.map(r => history(r, time, actor)) });
}

export function canWithdraw(activityStatus: string, registrationStatus: string) {
  return activityStatus === 'published' && ['submitted', 'waitlisted'].includes(registrationStatus);
}

export function canDecide(activityStatus: string, approved: ActivityPublicationContent | undefined) {
  return activityStatus === 'published' && canRecruit(approved);
}

export function canRequest(kind: 'exit' | 'restoration', activityStatus: string, status: string, approved: ActivityPublicationContent | undefined) {
  if (kind === 'restoration') return status === 'exited' && canDecide(activityStatus, approved);
  return status === 'accepted' && activityStatus === 'published' && canRecruit(approved, true);
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
  if (received.getTime() < opens) throw new BusinessError(409, 'registration_not_open', '尚未到报名开放时间');
  if (received.getTime() >= closes) throw new BusinessError(409, 'registration_closed', '报名已截止');
  const relation = { activity_id: activity.id, student_id };
  const previous = await tx.registration.findUnique({
    where: { activity_id_student_id: relation },
  });
  if (previous && previous.status !== 'withdrawn') {
    if (['submitted', 'waitlisted', 'accepted'].includes(previous.status)) return registrationView(previous);
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
  await recordChanges(tx, previous ? [previous] : [], [current], received, actor);
  return registrationView(current);
}

export function canRecruit(content: ActivityPublicationContent | undefined, exit = false, now = new Date()) {
  const schedule = content?.schedule;
  if (!schedule) return false;
  const boundary = schedule.schedule_type === 'date_range' && !exit ? 'ends_at' : 'starts_at';
  for (const { slot } of occurrences(schedule)) {
    if (Date.parse(slot[boundary]) > now.getTime()) return true;
  }
  return false;
}

export async function occupiedSeats(tx: Tx, activity_id: string) {
  return tx.registration.count({ where: { activity_id, status: 'accepted' } });
}

export async function enabledStudents(tx: Tx, ids: string[]) {
  const rows = await tx.$queryRaw<{ id: string; active: boolean }[]>`
    SELECT s.id, a.active FROM student s JOIN account a ON a.id = s.account_id
    WHERE s.id = ANY(${ids}::uuid[]) ORDER BY s.id FOR SHARE OF a, s`;
  return new Set(rows.filter((r) => r.active).map((r) => r.id));
}

export async function queueGathering(tx: Tx, activity_id: string, rows: Registration[]) {
  const source = await tx.notice.findFirst({
    where: { activity_id, notice_kind: 'gathering', source_notice_id: null, is_current: true },
    orderBy: { information_version: 'desc' },
  });
  if (!source) return;
  await tx.notificationEvent.createMany({
    data: rows.map((r) => ({
      event_type: 'gathering_supplement',
      event_key: `gathering:${r.id}:${r.version}:${source.id}`,
      activity_id,
      resource_id: r.id,
      payload: { student_id: r.student_id, registration_version: r.version, source_notice_id: source.id },
    })),
  });
}

export async function decideBatch(
  tx: Tx,
  activity: LoadedActivity,
  actor: string,
  input: BulkRegistrationDecision,
) {
  const ids = input.items.map((item) => item.registration_id.toLowerCase());
  if (new Set(ids).size !== ids.length) invalid('items', '同一批次不能重复选择报名');
  const rows = await tx.registration.findMany({ where: { activity_id: activity.id, id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const enabled = await enabledStudents(
    tx,
    rows.map((r) => r.student_id),
  );
  const now = new Date(),
    approved = approvedContent(activity);
  const available = canDecide(activity.status, approved);
  const failures = ids.flatMap((resource_id, i) => {
    const row = byId.get(resource_id);
    let code = 'invalid_state',
      message = '';
    if (!row) message = '该报名不属于当前活动或已不存在';
    else if (row.version !== input.items[i].expected_version) {
      code = 'version_conflict';
      message = '版本已更新，请刷新后复核';
    } else if (!enabled.has(row.student_id)) message = '学生已停用';
    else if (!available) message = '活动已结束或没有可办理的获批时段';
    else if (!canChangeRegistration(row.status, input.decision))
      message = '当前报名状态不能作此决定';
    return message ? [{ field: 'items', row: i + 1, resource_id, code, message }] : [];
  });
  if (failures.length) throw new BusinessError(409, failures[0].code, failures[0].message, failures);
  const occupied = await occupiedSeats(tx, activity.id);
  const accepting = input.decision === 'accepted';
  if (accepting && occupied + rows.length > approved!.capacity) {
    const message = `剩余 ${Math.max(0, approved!.capacity - occupied)} 个名额，所选 ${rows.length} 人均未录取`;
    throw new BusinessError(
      409,
      'capacity_conflict',
      message,
      ids.map((resource_id, i) => ({
        field: 'items',
        row: i + 1,
        resource_id,
        code: 'capacity_conflict',
        message,
      })),
    );
  }
  const changed = await tx.registration.updateManyAndReturn({
    where: { id: { in: ids } },
    data: { status: input.decision, version: { increment: 1 }, decision_reason: input.reason ?? null },
  });
  await recordChanges(tx, rows, changed, now, actor);
  await tx.notificationEvent.createMany({
    data: changed.map((r) => ({
      event_type: 'registration_decided',
      event_key: `registration_decision:${r.id}:${r.version}`,
      activity_id: activity.id, resource_id: r.id,
      payload: { student_id: r.student_id, registration_version: r.version, status: r.status,
        actor_id: actor, decision_reason: input.reason ?? null },
    })),
  });
  await audit(tx, {
    actor_id: actor,
    action: 'decide_registrations',
    resource_type: 'activity',
    resource_id: activity.id,
    reason: input.reason,
    before: rows.map((r) => ({ id: r.id, version: r.version, status: r.status })),
    after: changed.map((r) => ({ id: r.id, version: r.version, status: r.status })),
  });
  if (accepting) await queueGathering(tx, activity.id, changed);
  const result = new Map(changed.map((r) => [r.id, registrationView(r)]));
  return {
    items: ids.map((id) => result.get(id)!),
    affected_count: rows.length,
    accepted_count: occupied + (accepting ? rows.length : 0),
  };
}
