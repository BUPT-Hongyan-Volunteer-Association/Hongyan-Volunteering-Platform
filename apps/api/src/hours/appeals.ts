import type { Appeal, AppealDecision, AppealInput, HourRekeyItem } from '@hongyan/contracts/types';
import { parseCalendarDate } from '../activities/schedule.js';
import { checkVersion, wrongState, type Tx } from '../activities/workflow.js';
import { studentId, type Actor } from '../auth/session.guard.js';
import { audit } from '../audit.js';
import type { HourAppeal, Prisma } from '../generated/prisma/client.js';
import { BusinessError, invalid, invisible } from '../http.js';
import { enqueueHourNotices } from './events.js';
import { approvedOrigin, approvedTitles } from './read-ledger.js';
import { dateText } from './ledger-data.js';
import { beijingDay } from './values.js';

export const openAppealStates = ['pending', 'in_review'];
export const appealInclude = {
  student: { select: { student_no: true, account: { select: { display_name: true } } } },
  activity: { select: { activity_code: true, published_revision: true } },
} satisfies Prisma.HourAppealInclude;
type IncludedAppeal = Prisma.HourAppealGetPayload<{ include: typeof appealInclude }>;

export async function appealViews(tx: Tx, rows: IncludedAppeal[], own: boolean): Promise<Appeal[]> {
  const title = await approvedTitles(tx, rows.map((row) => ({
    activity_id: row.activity_id, revision: row.activity.published_revision,
  })));
  return rows.map((row) => ({
    id: row.id, version: row.version, student_id: row.student_id, activity_id: row.activity_id,
    target_type: row.target_type as Appeal['target_type'], status: row.status as Appeal['status'],
    description: row.description, service_date: dateText(row.service_date),
    activity_title: title(row.activity_id, row.activity.published_revision) ?? row.activity.activity_code,
    ...(!own && { student_no: row.student.student_no, student_name: row.student.account.display_name }),
    ...(row.target_id && { target_id: row.target_id }), ...(row.resolution && { resolution: row.resolution }),
    ...(row.correction_batch_id && { correction_batch_id: row.correction_batch_id }),
    ...(row.correction_group_id && { correction_group_id: row.correction_group_id }),
    ...(row.requested_hours && { requested_hours: row.requested_hours.toFixed(1) }),
    result_hour_record_ids: row.result_hour_record_ids,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  }));
}

export async function appealActivity(tx: Tx, input: AppealInput, actor: Actor) {
  const student_id = studentId(actor);
  if (input.target_type === 'missing_hours') return [input.activity_id!];
  if (input.target_type === 'hours') {
    const row = await tx.hourRecord.findFirst({ where: { id: input.target_id, student_id, ...approvedOrigin }, select: { activity_id: true } });
    if (row) return [row.activity_id];
  }
  if (input.target_type === 'incident') {
    const row = await tx.incident.findFirst({
      where: { id: input.target_id, student_id }, select: { activity_id: true },
    });
    if (row) return [row.activity_id];
  }
  return invisible();
}

export async function createAppeal(tx: Tx, input: AppealInput, actor: Actor, now: Date) {
  const student_id = studentId(actor);
  const description = input.description.trim();
  if (!description) invalid('description', '请说明需要核实的情况');
  if (input.evidence_file_ids?.length) invalid('evidence_file_ids', '此入口暂不支持上传证据');
  const missing = input.target_type === 'missing_hours';
  let resource: { activity_id: string; service_date: Date };
  if (missing) {
    const day = parseCalendarDate(input.service_date);
    if (!day || input.service_date! > beijingDay(now)) invalid('service_date', '请选择有效且非未来的服务日期');
    const published = await tx.activity.findFirst({
      where: { id: input.activity_id, OR: [
        { published_revision: { not: null } }, { registrations: { some: { student_id, status: 'accepted' } } },
      ] },
      select: { id: true },
    }) ?? invisible();
    resource = { activity_id: published.id, service_date: day };
  } else {
    const where = { id: input.target_id, student_id };
    const select = { activity_id: true, service_date: true };
    resource = (input.target_type === 'hours' ? await tx.hourRecord.findFirst({ where: { ...where, ...approvedOrigin }, select })
      : await tx.incident.findFirst({ where: { ...where, status: 'confirmed' }, select })) ?? invisible();
  }
  if (await tx.hourAppeal.findFirst({ where: {
    student_id, target_type: input.target_type, status: { in: openAppealStates },
    ...(missing ? resource : { target_id: input.target_id }),
  }, select: { id: true } })) throw new BusinessError(409, 'conflict', '已有同一事项的未结案反馈');
  const row = await tx.hourAppeal.create({ data: {
    ...resource, student_id, target_type: input.target_type, target_id: input.target_id,
    description, requested_hours: input.requested_hours,
  }, include: appealInclude });
  await audit(tx, { actor_id: actor.account_id, action: 'submit', resource_type: 'hour_appeal', resource_id: row.id,
    after: { status: row.status, target_type: row.target_type, activity_id: row.activity_id, service_date: dateText(row.service_date) } });
  const recipients = await tx.student.findMany({
    where: { id: { not: student_id }, account: { active: true,
      members: { some: { activity_id: row.activity_id } },
      roles: { some: { role: 'organizer', OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
    } }, select: { id: true },
  });
  await enqueueHourNotices(tx, 'hours_feedback', row.id, actor.account_id, recipients.map(({ id }) => ({
    student_id: id, activity_id: row.activity_id, title: '有新的活动反馈',
    body: '该活动收到新的本人记录反馈，请进入活动工作区核实。',
  })));
  return (await appealViews(tx, [row], true))[0];
}

async function resolutionFor(tx: Tx, appeal: HourAppeal, input: AppealDecision) {
  const { resolution_action: action, correction_batch_id: batchId, correction_group_id: groupId } = input;
  if (input.decision !== 'resolved') {
    if (action !== 'none' || batchId || groupId) invalid('resolution_action', '受理和驳回无需关联处理结果');
    return { ids: [], text: input.reason.trim() };
  }
  if (batchId && groupId) invalid('correction_group_id', '请选择一个已批准的处理结果');
  if (appeal.target_type === 'incident' && action === 'revoke_incident') {
    if (batchId || groupId) invalid('resolution_action', '异常结案仅关联异常撤销结果');
    if (!await tx.incident.findFirst({
      where: { id: appeal.target_id!, student_id: appeal.student_id, status: 'revoked' }, select: { id: true },
    })) invalid('resolution_action', '请先由老师正式撤销该异常');
    return { ids: [], text: '本人现场异常已撤销。' };
  }
  const origin = batchId ? await tx.hourImportBatch.findFirst({ where: { id: batchId, status: 'approved' } })
    : groupId ? await tx.hourCorrectionGroup.findFirst({ where: { id: groupId, status: 'approved' } }) : null;
  if (!origin) invalid('resolution_action', '请选择已批准的处理结果');
  if (appeal.target_type === 'missing_hours' && action === 'add_missing_hours') {
    const current = await tx.hourRecord.findFirst({ where: {
      student_id: appeal.student_id, activity_id: appeal.activity_id, service_date: appeal.service_date, status: 'current',
      ...(batchId ? { batch_id: batchId } : { correction_group_id: groupId }),
    } });
    if (!current) invalid('resolution_action', '找不到由该批准生成的本人同活动同日期有效记录');
    return { ids: [current.id], text: '本人 ' + current.hours.toFixed(1) + ' 小时已补记。' };
  }
  if (appeal.target_type !== 'hours') invalid('resolution_action', '请选择与反馈类型匹配的处理方式');
  const original = await tx.hourRecord.findFirst({
    where: { id: appeal.target_id!, student_id: appeal.student_id },
  }) ?? invisible();
  if (batchId && action === 'correct_hours') {
    const current = await tx.hourRecord.findFirst({ where: {
      student_id: appeal.student_id, supersedes_record_id: original.id, batch_id: batchId, status: 'current',
    } });
    if (current) return { ids: [current.id], text: '本人时长已更正为 ' + current.hours.toFixed(1) + ' 小时。' };
  }
  if (batchId && action === 'void_hours' && original.status === 'voided' && original.voided_by_batch_id === batchId)
    return { ids: [original.id], text: '本人错记时长已撤销。' };
  if (groupId && action === 'rekey_hours' && 'items' in origin && original.status === 'voided' && original.voided_by_group_id === groupId) {
    const item = (origin.items as unknown as HourRekeyItem[]).find((row) => row.source_record.id === original.id);
    if (item?.target_student_id === appeal.student_id && item.new_record_id) {
      const current = await tx.hourRecord.findFirst({ where: {
        id: item.new_record_id, student_id: appeal.student_id, status: 'current', correction_group_id: groupId,
      } });
      if (!current) invalid('resolution_action', '修复目标已变化，请复核本人有效记录');
      return { ids: [original.id, current.id], text: '本人错记时长已撤销，正确的服务记录已补记。' };
    }
    if (item) return { ids: [original.id], text: '本人错记时长已撤销。' };
  }
  return invalid('resolution_action', '所选结果尚未更正这条本人时长');
}

export async function decideAppeal(tx: Tx, id: string, input: AppealDecision, actor: Actor) {
  const row = await tx.hourAppeal.findUnique({ where: { id } }) ?? invisible();
  checkVersion(row.version, input.expected_version);
  if (!openAppealStates.includes(row.status) || (input.decision === 'in_review' && row.status !== 'pending')) wrongState();
  const reason = input.reason.trim();
  if (!reason) invalid('reason', '请填写处理意见');
  const { ids, text } = await resolutionFor(tx, row, input);
  const supplied = input.result_hour_record_ids?.map((recordId) => recordId.toLowerCase());
  if (supplied && (supplied.length !== ids.length || new Set(supplied).size !== ids.length ||
    supplied.some((recordId) => !ids.includes(recordId)))) invalid('result_hour_record_ids', '结果须与本人账务一致');
  const updated = await tx.hourAppeal.update({ where: { id }, data: {
    status: input.decision, resolution: text, version: { increment: 1 },
    correction_batch_id: input.correction_batch_id, correction_group_id: input.correction_group_id, result_hour_record_ids: ids,
  }, include: appealInclude });
  await audit(tx, { actor_id: actor.account_id, action: input.decision, resource_type: 'hour_appeal', resource_id: id,
    reason, before: { status: row.status }, after: { status: updated.status, resolution_action: input.resolution_action,
      correction_batch_id: updated.correction_batch_id, correction_group_id: updated.correction_group_id, result_hour_record_ids: ids },
  });
  if (input.decision !== 'in_review') await enqueueHourNotices(tx, 'appeal_result', id, actor.account_id, [{
    student_id: row.student_id, activity_id: row.activity_id, title: '本人反馈已有处理结果',
    body: dateText(row.service_date) + ' · ' + text,
  }]);
  return (await appealViews(tx, [updated], false))[0];
}
