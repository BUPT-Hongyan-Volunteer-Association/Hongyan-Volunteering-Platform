import type { HourCorrectionGroup as GroupView, HourCorrectionGroupInput, HourRekeyItem, HourReviewDecision, ReasonAction } from '@hongyan/contracts/types';
import { checkVersion, json, wrongState, type Reauthorize, type Tx } from '../activities/workflow.js';
import { parseCalendarDate } from '../activities/schedule.js';
import { staff } from '../activities/read.js';
import type { Actor } from '../auth/session.guard.js';
import type { HourCorrectionGroup } from '../generated/prisma/client.js';
import { BusinessError, denied, invalid, invisible } from '../http.js';
import { audit } from '../audit.js';
import { approvedCoverage, dateText, indexHistory, lockLedger, projectWarnings, readHistory, recordKey, tenths,
  versionConflict, type Projection } from './ledger-data.js';
import { beijingDay, hours } from './values.js';
import { approvedOrigin, hourRecordInclude, hourRecordViews } from './read-ledger.js';
import { acceptWarnings, warningSnapshot } from './warnings.js';
import { enqueueHourNotices } from './events.js';

export function groupView(group: HourCorrectionGroup): GroupView {
  return {
    id: group.id, version: group.version, status: group.status as GroupView['status'],
    items: group.items as unknown as HourRekeyItem[], reason: group.reason, submitted_by: group.submitted_by,
    warnings: group.warnings as unknown as GroupView['warnings'], warning_snapshot_hash: group.warning_snapshot_hash,
    created_at: group.created_at.toISOString(), ...(group.appeal_id && { appeal_id: group.appeal_id }),
    ...(group.reviewed_by && { reviewed_by: group.reviewed_by }),
    ...(group.reviewed_at && { reviewed_at: group.reviewed_at.toISOString() }),
    ...(group.decision_reason && { decision_reason: group.decision_reason }),
  };
}

export async function correctionActivities(tx: Tx, input: HourCorrectionGroupInput) {
  const sources = [...new Set(input.items.map((item) => item.source_record_id.toLowerCase()))];
  const rows = await tx.hourRecord.findMany({
    where: { id: { in: sources }, ...approvedOrigin }, select: { activity_id: true },
  });
  if (rows.length !== sources.length) invisible();
  return [...rows.map((row) => row.activity_id), ...input.items.map((item) => item.target_activity_id.toLowerCase())];
}

export async function groupActivities(tx: Tx, id: string) {
  return (await tx.hourCorrectionGroupActivity.findMany({ where: { group_id: id } })).map((row) => row.activity_id);
}

const targetKey = (item: HourRekeyItem) => ({
  student_id: item.target_student_id, activity_id: item.target_activity_id, service_date: item.target_service_date,
});
const activityIds = (items: HourRekeyItem[]) =>
  [...new Set(items.flatMap((item) => [item.source_record.activity_id, item.target_activity_id]))];

async function checkGroup(tx: Tx, items: HourRekeyItem[], now: Date, creating: boolean, reauthorize: Reauthorize) {
  const keys = items.flatMap((item) => [item.source_record, targetKey(item)]);
  await lockLedger(tx, keys);
  await reauthorize();
  const { existing, daily } = indexHistory(await readHistory(tx, keys));
  const revisions = await tx.activityRevision.findMany({
    where: { activity_id: { in: activityIds(items) }, revision_state: 'approved' },
  });
  const coverages = new Map(activityIds(items).map((id) =>
    [id, approvedCoverage(revisions.filter((row) => row.activity_id === id))]));
  const projections: Projection[] = [];
  const today = beijingDay(now);
  for (const [index, item] of items.entries()) {
    const source = item.source_record, target = targetKey(item);
    const old = existing.get(recordKey(source));
    if (!old || old.id !== source.id || old.status !== 'current' || old.version !== source.version
      || old.origin_schedule_revision !== source.origin_schedule_revision
      || coverages.get(source.activity_id)!(old.origin_schedule_revision, source.service_date) === 0) versionConflict();
    if (existing.has(recordKey(target))) {
      throw new BusinessError(409, 'target_key_conflict', '第 ' + (index + 1) + ' 对的目标记录键已被使用');
    }
    const duration = coverages.get(target.activity_id)!(item.target_schedule_revision, target.service_date);
    if (duration === 0 || target.service_date > today) {
      if (!creating) versionConflict();
      invalid('items.' + index + '.target_service_date', '目标日期须为获批安排内的非未来日期');
    }
    const common = { row_number: index + 2, explanation: item.reason };
    projections.push({ ...source, ...common, previous: tenths(old.hours), value: 0, duration: null });
    projections.push({ ...target, ...common, previous: 0, value: tenths(item.credited_hours), duration });
  }
  return { warnings: projectWarnings(daily, projections), revisions };
}

export async function createGroup(tx: Tx, input: HourCorrectionGroupInput, actor: Actor, now: Date, reauthorize: Reauthorize) {
  const reason = input.reason.trim();
  if (!reason) invalid('reason', '请填写整组修复原因');
  const source_record_ids = input.items.map((item) => item.source_record_id.toLowerCase());
  if (new Set(source_record_ids).size !== source_record_ids.length) invalid('items', '源时长记录不可重复');
  const saved = await tx.hourRecord.findMany({ where: { id: { in: source_record_ids } }, include: hourRecordInclude });
  const sources = new Map((await hourRecordViews(tx, saved)).map((row) => [row.id, row]));
  const students = new Map((await tx.student.findMany({
    where: { student_no: { in: input.items.map((row) => row.target_student_no) } },
    select: { id: true, student_no: true, account: { select: { display_name: true } } },
  })).map((row) => [row.student_no, row]));
  const targetKeys = new Set<string>();
  const items: HourRekeyItem[] = input.items.map((item, index) => {
    const source_record = sources.get(source_record_ids[index]) ?? invisible();
    checkVersion(source_record.version, item.expected_source_version);
    const target = students.get(item.target_student_no);
    if (!target || target.account.display_name !== item.target_student_name.trim())
      invalid('items.' + index + '.target_student_name', '目标学号与姓名未匹配');
    if (!parseCalendarDate(item.target_service_date)) invalid('items.' + index + '.target_service_date', '目标日期无效');
    if (!item.reason.trim()) invalid('items.' + index + '.reason', '请填写该笔修复原因');
    const row = {
      source_record, target_student_id: target.id, target_student_no: target.student_no,
      target_student_name: target.account.display_name, target_activity_id: item.target_activity_id.toLowerCase(),
      target_service_date: item.target_service_date, target_schedule_revision: item.target_schedule_revision,
      credited_hours: hours(tenths(item.credited_hours)), reason: item.reason.trim(),
    };
    const key = recordKey(targetKey(row));
    if (key === recordKey(source_record)) invalid('items.' + index, '目标键须与源记录不同');
    if (targetKeys.has(key))
      throw new BusinessError(409, 'target_key_conflict', '第 ' + (index + 1) + ' 对的目标记录键在组内重复');
    targetKeys.add(key);
    return row;
  });
  const { warnings, revisions } = await checkGroup(tx, items, now, true, reauthorize);
  const titles = new Map(revisions.map((row) =>
    [row.activity_id + '/' + row.revision, (row.content as { title?: string }).title]));
  for (const item of items) {
    item.target_activity_title = titles.get(item.target_activity_id + '/' + item.target_schedule_revision);
  }
  if (await tx.hourCorrectionGroup.findFirst({
    where: { status: 'pending_review', source_record_ids: { hasSome: source_record_ids } }, select: { id: true },
  })) throw new BusinessError(409, 'conflict', '某条源记录已有待审核修复组');
  if (input.appeal_id) {
    const appeal = await tx.hourAppeal.findUnique({ where: { id: input.appeal_id } });
    if (!appeal || !items.some((item) => appeal.target_type === 'hours'
      ? appeal.target_id === item.source_record.id && appeal.student_id === item.source_record.student_id
      : appeal.target_type === 'missing_hours' && appeal.student_id === item.target_student_id &&
        appeal.activity_id === item.target_activity_id && dateText(appeal.service_date) === item.target_service_date)) invisible();
    if (appeal.status !== 'pending' && appeal.status !== 'in_review') wrongState();
  }
  const snapshot = warningSnapshot(warnings);
  const group = await tx.hourCorrectionGroup.create({ data: {
    source_record_ids, reason, submitted_by: actor.account_id, items: json(items),
    warnings: json(snapshot.warnings), warning_snapshot_hash: snapshot.warning_snapshot_hash, appeal_id: input.appeal_id,
    activities: { createMany: { data: activityIds(items).map((activity_id) => ({ activity_id })) } },
  } });
  await audit(tx, { actor_id: actor.account_id, action: 'submit', resource_type: 'hour_correction_group',
    resource_id: group.id, reason, after: { status: group.status, source_record_ids, item_count: items.length } });
  return groupView(group);
}

async function pendingGroup(tx: Tx, id: string, expected: number) {
  const group = await tx.hourCorrectionGroup.findUnique({ where: { id } }) ?? invisible();
  checkVersion(group.version, expected);
  if (group.status !== 'pending_review') wrongState();
  return group;
}

export async function withdrawGroup(tx: Tx, id: string, input: ReasonAction, actor: Actor) {
  const group = await pendingGroup(tx, id, input.expected_version);
  if (group.submitted_by !== actor.account_id && !staff(actor)) denied();
  const reason = input.reason.trim();
  if (!reason) invalid('reason', '请填写撤回原因');
  const updated = await tx.hourCorrectionGroup.update({ where: { id }, data: {
    status: 'withdrawn', version: { increment: 1 }, decision_reason: reason,
  } });
  await audit(tx, { actor_id: actor.account_id, action: 'withdraw', resource_type: 'hour_correction_group', resource_id: id,
    reason, before: { status: group.status }, after: { status: updated.status } });
  return groupView(updated);
}

export async function reviewGroup(tx: Tx, id: string, input: HourReviewDecision, actor: Actor, now: Date, reauthorize: Reauthorize) {
  const group = await pendingGroup(tx, id, input.expected_version);
  if (group.submitted_by === actor.account_id) denied();
  const reason = input.reason?.trim();
  let { items, warnings, warning_snapshot_hash } = groupView(group);
  const changes: object[] = [];
  if (input.decision === 'approved') {
    const projected = await checkGroup(tx, items, now, false, reauthorize);
    ({ warnings, warning_snapshot_hash } = acceptWarnings(input, warning_snapshot_hash, projected.warnings));
    await tx.hourRecord.updateMany({ where: { id: { in: group.source_record_ids } }, data: {
      status: 'voided', version: { increment: 1 }, updated_at: now, voided_by_group_id: id,
    } });
    const added = await tx.hourRecord.createManyAndReturn({ data: items.map((item) => ({
      student_id: item.target_student_id, activity_id: item.target_activity_id,
      service_date: parseCalendarDate(item.target_service_date)!, hours: item.credited_hours,
      origin_schedule_revision: item.target_schedule_revision, version: 1, status: 'current',
      misconduct_reported: 'not_provided', misconduct_version: 0, correction_group_id: id,
      created_at: now, updated_at: now, reviewed_at: now,
    })) });
    const newIds = new Map(added.map((row) => [recordKey({ ...row, service_date: dateText(row.service_date) }), row.id]));
    items = items.map((item) => ({ ...item, new_record_id: newIds.get(recordKey(targetKey(item)))! }));
    const recipients = new Map<string, { student_id: string; activity_id: string; revision: number; lines: string[] }>();
    function notify(student_id: string, activity_id: string, revision: number, line: string) {
      const key = student_id + '/' + activity_id;
      const recipient = recipients.get(key) ?? { student_id, activity_id, revision, lines: [] };
      recipient.lines.push(line);
      recipients.set(key, recipient);
    }
    for (const item of items) {
      const original = item.source_record;
      notify(original.student_id, original.activity_id, original.origin_schedule_revision,
        original.service_date + ' 错记的 ' + original.credited_hours + ' 小时已撤销');
      notify(item.target_student_id, item.target_activity_id, item.target_schedule_revision,
        item.target_service_date + ' 已补记 ' + item.credited_hours + ' 小时');
      changes.push({
        source_record_id: original.id, source_hours: original.credited_hours, source_schedule_revision: original.origin_schedule_revision,
        target_record_id: item.new_record_id, target_hours: item.credited_hours, target_schedule_revision: item.target_schedule_revision,
      });
    }
    await enqueueHourNotices(tx, 'hours_result', id, actor.account_id, [...recipients.values()].map(({ lines, ...recipient }) => ({
      ...recipient, title: '时长错账修复结果', body: lines.length > 20
        ? '你的 ' + lines.length + ' 条时长变更已生效，请查看我的时长。' : lines.join('\n'),
    })));
  }
  const updated = await tx.hourCorrectionGroup.update({ where: { id }, data: {
    status: input.decision, version: { increment: 1 }, reviewed_at: now, reviewed_by: actor.account_id,
    decision_reason: reason, items: json(items), warnings: json(warnings), warning_snapshot_hash,
  } });
  await audit(tx, { actor_id: actor.account_id, action: input.decision === 'approved' ? 'approve' : 'reject',
    resource_type: 'hour_correction_group', resource_id: id, reason, before: { status: group.status },
    after: { status: updated.status, warning_snapshot_hash, changes } });
  return groupView(updated);
}
