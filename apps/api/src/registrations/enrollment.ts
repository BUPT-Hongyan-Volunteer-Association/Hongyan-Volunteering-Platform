import { createHash } from 'node:crypto';
import type {
  ActivityInput,
  SurveyQuestion,
  SurveyAnswer,
  RegistrationInput,
} from '@hongyan/contracts/types';
import { activeRegistrationStatuses, registrationItemLabel, selectionRestriction } from '@hongyan/contracts/activity';
import { json, stable, type Tx } from '../database.js';
import type { QuestionnaireAnswer, Registration } from '../generated/prisma/client.js';
import { BusinessError, invalid } from '../http.js';

export const wholeItemId = '00000000-0000-0000-0000-000000000000';
type Questions = SurveyQuestion[];

export function pools(content: ActivityInput) {
  if (content.registration_mode === 'batch')
    return (content.registration_items ?? []).map((item) => ({
      ...item,
      id: item.id.toLowerCase(),
      label: registrationItemLabel(item),
    }));
  return [
    {
      id: wholeItemId,
      capacity: content.capacity ?? 0,
      waitlist_capacity: content.waitlist_capacity ?? 0,
      label: '整批报名',
    },
  ];
}

export async function registrationInventory(tx: Tx, activity_id: string, content?: ActivityInput) {
  if (!content) return [];
  const counts = await tx.registration.groupBy({
    by: ['item_id', 'status'],
    where: { activity_id, status: { in: activeRegistrationStatuses } },
    _count: true,
  });
  const byItem = new Map<string, Map<string, number>>();
  for (const row of counts) {
    const values = byItem.get(row.item_id) ?? new Map<string, number>();
    values.set(row.status, row._count);
    byItem.set(row.item_id, values);
  }
  return pools(content).map((item) => {
    const count = byItem.get(item.id);
    const accepted_count = count?.get('accepted') ?? 0;
    const waitlisted_count = count?.get('waitlisted') ?? 0;
    const submitted_count = count?.get('submitted') ?? 0;
    const active_count = accepted_count + waitlisted_count + submitted_count;
    return {
      ...(item.id !== wholeItemId && { item_id: item.id }),
      item_label: item.label,
      capacity: item.capacity,
      waitlist_capacity: item.waitlist_capacity,
      submitted_count,
      accepted_count,
      waitlisted_count,
      active_count,
      remaining: Math.max(0, item.capacity + item.waitlist_capacity - active_count),
    };
  });
}

type Change = { item_id: string; status: string; previous?: string; id?: string };
const active = (status?: string) => activeRegistrationStatuses.some((s) => s === status);
export async function checkCapacity(tx: Tx, activity_id: string, content: ActivityInput, changes: Change[]) {
  const inventory = await registrationInventory(tx, activity_id, content);
  const byItem = new Map(inventory.map((pool) => [pool.item_id ?? wholeItemId, pool]));
  for (const change of changes) {
    const pool = byItem.get(change.item_id);
    if (!pool) invalid('item_ids', '该报名项已调整，请刷新后核对');
    pool.active_count += Number(active(change.status)) - Number(active(change.previous));
    pool.accepted_count += Number(change.status === 'accepted') - Number(change.previous === 'accepted');
    pool.waitlisted_count += Number(change.status === 'waitlisted') - Number(change.previous === 'waitlisted');
  }
  for (const [id, pool] of byItem) {
    const reason =
      pool.accepted_count > pool.capacity
        ? '录取名额不足'
        : pool.waitlisted_count > pool.waitlist_capacity
          ? '候补名额不足'
          : pool.active_count > pool.capacity + pool.waitlist_capacity
            ? '报名已满'
            : '';
    if (!reason || !changes.some((change) => change.item_id === id)) continue;
    const message = pool.item_label + ' · ' + reason;
    throw new BusinessError(
      409,
      'capacity_conflict',
      message,
      changes.flatMap((change, index) =>
        change.item_id === id
          ? [
              {
                field: change.id ? 'items' : 'item_ids',
                row: index + 1,
                resource_id: change.id ?? id,
                code: 'capacity_conflict',
                message,
              },
            ]
          : [],
      ),
    );
  }
}

export function checkSelections(content: ActivityInput, ids: string[]) {
  if (content.registration_mode !== 'batch') return;
  const selected = new Set(ids);
  const items = (content.registration_items ?? []).filter((item) => selected.has(item.id.toLowerCase()));
  const error = selectionRestriction(content, items);
  if (error) invalid('item_ids', error);
}

export async function checkReactivation(
  tx: Tx,
  activity_id: string,
  content: ActivityInput,
  rows: Pick<Registration, 'student_id' | 'item_id'>[],
) {
  if (
    !rows.length ||
    content.registration_mode !== 'batch' ||
    (content.allow_multiple_roles && content.allow_multiple_slots)
  )
    return;
  const students = [...new Set(rows.map((row) => row.student_id))];
  const current = await tx.registration.findMany({
    where: { activity_id, student_id: { in: students }, status: { in: activeRegistrationStatuses } },
    select: { student_id: true, item_id: true },
  });
  const selected = new Map<string, string[]>();
  for (const row of [...current, ...rows]) {
    const items = selected.get(row.student_id) ?? [];
    items.push(row.item_id);
    selected.set(row.student_id, items);
  }
  for (const ids of selected.values()) checkSelections(content, ids);
}

export function questionnaireVersion(questions: Questions = []) {
  return createHash('sha256').update(stable(questions)).digest('hex');
}

export function answerView(a: QuestionnaireAnswer): SurveyAnswer {
  return {
    question_id: a.question_id,
    title: a.title,
    type: a.type as SurveyAnswer['type'],
    ...(a.text !== null && { text: a.text }),
    ...(a.option_ids.length && { option_ids: a.option_ids, labels: a.labels }),
  };
}

export async function responseFor(
  tx: Tx,
  activity_id: string,
  student_id: string,
  questions: Questions,
  input: RegistrationInput,
) {
  const version = questionnaireVersion(questions);
  if ((questions.length || input.questionnaire_version) && input.questionnaire_version !== version)
    throw new BusinessError(409, 'version_conflict', '报名问卷已更新，请复核后提交');
  const supplied = input.answers ?? [];
  if (!questions.length) {
    if (supplied.length) invalid('answers', '本活动未设置问卷');
    return null;
  }
  const identity = { activity_id, student_id, questionnaire_version: version };
  const previous = await tx.questionnaireResponse.findUnique({
    where: { activity_id_student_id_questionnaire_version: identity },
    select: { id: true },
  });
  if (previous && !supplied.length) return previous.id;
  const answers = new Map(supplied.map((answer) => [answer.question_id, answer]));
  if (
    answers.size !== supplied.length ||
    supplied.some((answer) => !questions.some((q) => q.id === answer.question_id))
  )
    invalid('answers', '含有重复或不属于本问卷的答案');
  const rows = questions.map((q, position) => {
    const raw = answers.get(q.id);
    const option_ids = raw?.option_ids ?? [];
    const text = raw?.text?.trim() || null;
    const field = 'answers.' + q.id;
    if (q.type === 'text' ? option_ids.length > 0 : raw?.text !== undefined) invalid(field, '答案格式与题型不符');
    if (q.type === 'single' && option_ids.length > 1) invalid(field, '单选题只能选择一项');
    const selected = (q.options ?? []).filter((o) => option_ids.includes(o.id));
    if (selected.length !== option_ids.length) invalid(field, '选项重复或已无效');
    if (q.required && !text && !selected.length) invalid(field, '请填写必答题');
    return {
      question_id: q.id,
      type: q.type,
      title: q.title,
      position,
      text,
      option_ids: selected.map((o) => o.id),
      labels: selected.map((o) => o.label),
    };
  });
  if (previous) {
    const saved = await tx.questionnaireAnswer.findMany({
      where: { response_id: previous.id },
      orderBy: { position: 'asc' },
      select: {
        question_id: true,
        type: true,
        title: true,
        position: true,
        text: true,
        option_ids: true,
        labels: true,
      },
    });
    if (stable(saved) !== stable(rows))
      throw new BusinessError(409, 'conflict', '本版本已有答卷，请复用已提交的答案');
    return previous.id;
  }
  const response = await tx.questionnaireResponse.create({
    data: { ...identity, questions: json(questions), answers: { create: rows } },
    select: { id: true },
  });
  return response.id;
}
