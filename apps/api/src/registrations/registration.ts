import { activeRegistrationStatuses, activityBounds, canChangeRegistration } from '@hongyan/contracts/activity';
import { audit } from '../audit.js';
import type {
  ActivityPublicationContent,
  Registration as View,
  BulkRegistrationDecision,
  RegistrationInput,
} from '@hongyan/contracts/types';
import type { Prisma, Registration, QuestionnaireResponse, QuestionnaireAnswer } from '../generated/prisma/client.js';
import { occurrences } from '../activities/schedule.js';
import { publishedRevision, type LoadedActivity } from '../activities/read.js';
import { wrongState, BusinessError, invalid, invisible } from '../http.js';
import { type Tx } from '../database.js';

import { answerView, checkCapacity, checkReactivation, checkSelections, pools, responseFor, wholeItemId } from './enrollment.js';

const responseWithAnswers = { include: { answers: { orderBy: { position: 'asc' } } } } as const;
export const includeResponse = {
  response: responseWithAnswers,
  history: {
    where: { response_id: { not: null } },
    orderBy: { version: 'desc' },
    select: { submitted_at: true, response: responseWithAnswers },
  },
} as const;
export const rosterOrderBy = [
  { submitted_at: 'asc' },
  { id: 'asc' },
] satisfies Prisma.RegistrationOrderByWithRelationInput[];

/** 名单页面和导出共用的搜索条件；状态过滤由调用方决定是否叠加。 */
type RosterFilters = {
  activity_id: string;
  q?: string;
  item_id?: string;
  answer_filters?: string;
  registration_ids?: string[];
  status?: string;
};
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function answerConditions(value?: string): Prisma.RegistrationWhereInput[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.length > 32000) invalid('answer_filters', '答案筛选格式无效');
  let conditions: unknown;
  try {
    conditions = JSON.parse(value);
  } catch {
    invalid('answer_filters', '答案筛选格式无效');
  }
  if (!Array.isArray(conditions) || conditions.length > 100) invalid('answer_filters', '答案筛选格式无效');
  const entries: Prisma.QuestionnaireResponseWhereInput[] = conditions.map((c) => {
    if (
      !c ||
      typeof c.question_id !== 'string' ||
      !uuid.test(c.question_id) ||
      (c.questionnaire_version !== undefined && (typeof c.questionnaire_version !== 'string' || !/^[0-9a-f]{64}$/.test(c.questionnaire_version))) ||
      (c.option_id !== undefined && (typeof c.option_id !== 'string' || !uuid.test(c.option_id))) ||
      (c.answer_text !== undefined && (typeof c.answer_text !== 'string' || !c.answer_text.trim())) ||
      Boolean(c.option_id) === Boolean(c.answer_text)
    )
      invalid('answer_filters', '请选择题目和选项或填写关键词');
    return {
      questionnaire_version: c.questionnaire_version,
      answers: {
        some: {
          question_id: c.question_id,
          ...(c.option_id
            ? { option_ids: { has: c.option_id } }
            : { text: { contains: c.answer_text.trim(), mode: 'insensitive' } }),
        },
      },
    };
  });
  if (!entries.length) return [];
  const response = { AND: entries };
  return [{ OR: [{ response }, { history: { some: { response } } }] }];
}
export function rosterSearchWhere(filters: RosterFilters): Prisma.RegistrationWhereInput {
  const search = filters.q?.trim();
  if (filters.item_id !== undefined && (typeof filters.item_id !== 'string' || !uuid.test(filters.item_id)))
    invalid('item_id', '报名项编号无效');
  return {
    activity_id: filters.activity_id,
    item_id: filters.item_id,
    AND: answerConditions(filters.answer_filters),
    ...(filters.registration_ids && { id: { in: filters.registration_ids } }),
    ...(search && {
      student: { OR: [{ student_no: { contains: search } }, { account: { display_name: { contains: search } } }] },
    }),
  };
}
export function rosterWhere(filters: RosterFilters): Prisma.RegistrationWhereInput {
  return { ...rosterSearchWhere(filters), status: filters.status };
}

export function approvedContent(activity: LoadedActivity) {
  const revision = publishedRevision(activity);
  return revision?.content as unknown as ActivityPublicationContent | undefined;
}

type LoadedResponse = QuestionnaireResponse & { answers?: QuestionnaireAnswer[] };
export function registrationView(
  row: Registration & {
    response?: LoadedResponse | null;
    history?: { submitted_at: Date; response?: LoadedResponse | null }[];
  },
): View {
  const seen = new Set([row.response_id]);
  const answer_history = (row.history ?? []).flatMap((h) => {
    const response = h.response;
    if (!response?.answers || seen.has(response.id)) return [];
    seen.add(response.id);
    return [
      {
        submitted_at: h.submitted_at.toISOString(),
        questionnaire_version: response.questionnaire_version,
        answers: response.answers.map(answerView),
      },
    ];
  });
  return {
    id: row.id,
    activity_id: row.activity_id,
    student_id: row.student_id,
    version: row.version,
    status: row.status as View['status'],
    submitted_at: row.submitted_at.toISOString(),
    ...(row.item_id !== wholeItemId && { item_id: row.item_id, item_label: row.item_label ?? undefined }),
    ...(answer_history.length && { answer_history }),
    ...(row.response?.answers && {
      questionnaire_version: row.response.questionnaire_version,
      answers: row.response.answers.map(answerView),
    }),
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
    response_id:row.status === 'submitted' ? row.response_id : null,
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
  if (current.length) {
    await tx.registrationHistory.createMany({ data: current.map(r => history(r, time, actor)) });
    await tx.$queryRaw`SELECT pg_notify('registration_changed', ${current[0].activity_id})::text`;
  }
}

export function canWithdraw(activityStatus: string, registrationStatus: string) {
  return activityStatus === 'published' && ['submitted', 'waitlisted'].includes(registrationStatus);
}

function itemTime(approved: ActivityPublicationContent | undefined, id?: string) {
  return approved?.registration_mode === 'batch'
    ? approved.registration_items?.find((item) => item.id === id)
    : undefined;
}

export function canDecide(
  activityStatus: string,
  approved: ActivityPublicationContent | undefined,
  itemId?: string,
  now = Date.now(),
) {
  const bounds = activityBounds(approved?.schedule);
  const end = itemTime(approved, itemId)?.ends_at;
  return activityStatus === 'published' && !!bounds && now < bounds.end && (!end || now < Date.parse(end));
}

export function canRequest(
  kind: 'exit' | 'restoration',
  activityStatus: string,
  status: string,
  approved: ActivityPublicationContent | undefined,
  itemId?: string,
) {
  if (activityStatus !== 'published') return false;
  if (kind === 'restoration')
    return (
      status === 'exited' &&
      (approved?.registration_mode === 'batch'
        ? canDecide(activityStatus, approved, itemId)
        : canRecruit(approved))
    );
  const start = itemTime(approved, itemId)?.starts_at;
  return status === 'accepted' && (start ? Date.now() < Date.parse(start) : canRecruit(approved, true));
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
  const available = new Map(pools(approved).map((pool) => [pool.id, pool]));
  const ids = input.item_ids?.map((id) => id.toLowerCase()) ?? [];
  if (approved.registration_mode === 'batch') {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !available.has(id)))
      invalid('item_ids', '请选择有效且不同的报名项');
  } else {
    if (ids.length) invalid('item_ids', '整批报名无需选择岗位或时段');
    ids.push(wholeItemId);
  }
  const relation = { activity_id: activity.id, student_id };
  const previous = await tx.registration.findMany({
    where: relation,
    select: { id: true, item_id: true, status: true },
  });
  const byItem = new Map(previous.map((row) => [row.item_id, row]));
  const selected = ids.flatMap((id) => byItem.get(id) ?? []);
  if (selected.some((row) => ![...activeRegistrationStatuses, 'withdrawn'].includes(row.status))) wrongState();
  const withdrawn = selected.filter((row) => row.status === 'withdrawn');
  const fresh = ids.filter((id) => !byItem.has(id));
  if (withdrawn.length || fresh.length) {
    const adding = [...fresh, ...withdrawn.map((row) => row.item_id)];
    checkSelections(approved, [
      ...previous
        .filter((row) => activeRegistrationStatuses.some((s) => s === row.status))
        .map((row) => row.item_id),
      ...adding,
    ]);
    await checkCapacity(
      tx,
      activity.id,
      approved,
      adding.map((item_id) => ({ item_id, status: 'submitted' })),
    );
    const response_id = await responseFor(tx, activity.id, student_id, approved.questions ?? [], input);
    const data = {
      status: 'submitted',
      submitted_at: received,
      decision_reason: null,
      statement: null,
      response_id,
    };
    const resumed = withdrawn.length
      ? await tx.registration.updateManyAndReturn({
          where: { id: { in: withdrawn.map((row) => row.id) } },
          data: { ...data, version: { increment: 1 } },
        })
      : [];
    const created = fresh.length
      ? await tx.registration.createManyAndReturn({
          data: fresh.map((item_id) => ({
            ...data,
            ...relation,
            item_id,
            item_label: item_id === wholeItemId ? null : available.get(item_id)!.label,
          })),
        })
      : [];
    await recordChanges(tx, [], [...resumed, ...created], received, actor);
  }
  const rows = await tx.registration.findMany({
    where: { ...relation, item_id: { in: ids } },
    include: includeResponse,
  });
  const result = new Map(rows.map((row) => [row.item_id, registrationView(row)]));
  return { items: ids.map((id) => result.get(id)!) };
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
    else if (!available || (input.decision !== 'rejected' && !canDecide(activity.status,approved,row.item_id,now.getTime())))
      message = '活动或该服务时段已结束';
    else if (!canChangeRegistration(row.status, input.decision))
      message = '当前报名状态不能作此决定';
    return message ? [{ field: 'items', row: i + 1, resource_id, code, message }] : [];
  });
  if (failures.length) throw new BusinessError(409, failures[0].code, failures[0].message, failures);
  const occupied = await occupiedSeats(tx, activity.id);
  const accepting = input.decision === 'accepted';
  if (input.decision !== 'rejected') {
    await checkCapacity(tx,activity.id,approved!,rows.map(r => ({id:r.id,item_id:r.item_id,status:input.decision,previous:r.status})));
    await checkReactivation(tx,activity.id,approved!,rows.filter(row=>row.status==='rejected'));
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
        actor_id: actor, decision_reason: input.reason ?? null, item_label:r.item_label },
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
