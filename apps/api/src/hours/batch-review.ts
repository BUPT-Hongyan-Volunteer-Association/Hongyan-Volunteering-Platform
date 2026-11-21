import { randomUUID } from 'node:crypto';
import type { HourBatch, HourBatchReviewDecision, HourBatchSubmit, HourMisconductReview, HourRow, HourWarning, ReasonAction } from '@hongyan/contracts/types';
import { checkVersion, json, wrongState, type Reauthorize, type Tx } from '../activities/workflow.js';
import type { LoadedActivity } from '../activities/read.js';
import type { Actor } from '../auth/session.guard.js';
import type { HourImportBatch, Prisma } from '../generated/prisma/client.js';
import { BusinessError, denied, invalid, invisible } from '../http.js';
import { audit } from '../audit.js';
import { batchView, digest, emptySummary, type SourceInfo } from './batch-data.js';
import { approvedCoverage, dateText, factKey, indexHistory, lockLedger, projectWarnings, readFactReviews,
  readHistory, recordKey, tenths, versionConflict, type LedgerKey } from './ledger-data.js';
import { beijingDay, hours, normalizeFact } from './values.js';
import { acceptWarnings, warningSnapshot } from './warnings.js';
import { enqueueHourNotices } from './events.js';

type FrozenRow = HourRow & LedgerKey & {
  credited_hours: string;
  bound_schedule_revision: number;
};
const actions = ['add', 'correct', 'review_only', 'void'];

async function batchForUpdate(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM hour_import_batch WHERE id = ${id}::uuid FOR UPDATE`;
  return await tx.hourImportBatch.findUnique({ where: { id } }) ?? invisible();
}

async function writeRows(tx: Tx, batchId: string, rows: FrozenRow[]) {
  await tx.$executeRaw`
    UPDATE hour_import_row AS row SET detail = updated.detail
    FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ activity_id, ...detail }) =>
      ({ row_number: detail.row_number, detail })))}::jsonb) AS updated(row_number int, detail jsonb)
    WHERE row.batch_id = ${batchId}::uuid AND row.row_number = updated.row_number`;
}

async function batchRows(tx: Tx, batch: HourImportBatch) {
  const rows = (await tx.hourImportRow.findMany({
    where: { batch_id: batch.id, action: { in: actions } }, orderBy: { row_number: 'asc' },
  })).map(({ detail }) => detail as unknown as FrozenRow);
  if (!rows.length) invalid('rows', '至少需要一行有效的时长操作');
  // 升级前的预览保存了学号和姓名。只在送审时补齐能够匹配的档案 ID。
  const legacy = rows.filter((row) => !row.student_id);
  if (legacy.length) {
    const people = await tx.student.findMany({
      where: { student_no: { in: legacy.map((row) => row.student_no!) } },
      select: { id: true, student_no: true, account: { select: { display_name: true } } },
    });
    const byNumber = new Map(people.map((person) => [person.student_no, person]));
    for (const row of legacy) {
      const person = byNumber.get(row.student_no!);
      if (!person || person.account.display_name !== row.student_name) versionConflict('学生档案已变化，请重新上传');
      row.student_id = person.id;
    }
  }
  for (const row of rows) row.activity_id = batch.activity_id;
  return rows;
}

async function checkedRows(tx: Tx, batch: HourImportBatch, activity: LoadedActivity, now: Date, reauthorize: Reauthorize) {
  const rows = await batchRows(tx, batch);
  await lockLedger(tx, rows);
  await reauthorize();
  const { existing, daily } = indexHistory(await readHistory(tx, rows));
  const facts = await readFactReviews(tx, rows);
  const coverage = approvedCoverage(activity.revisions);
  const entries = rows.map((row) => {
    const record = existing.get(recordKey(row));
    const duration = coverage(row.bound_schedule_revision, row.service_date);
    if (duration === 0 || row.service_date > beijingDay(now)) versionConflict();
    if (row.action === 'add') {
      if (record || row.bound_schedule_revision !== (batch.metadata as unknown as SourceInfo).schedule_revision)
        versionConflict();
    } else if (!record || record.id !== row.existing_record_id || record.version !== row.existing_version
      || record.origin_schedule_revision !== row.bound_schedule_revision || record.status === 'superseded'
      || record.misconduct_version !== row.misconduct_version
      || (row.action !== 'correct' && record.status !== 'current')) versionConflict();
    const fact = normalizeFact(row.remark ?? '');
    const reused = row.misconduct_reported === 'reported' && row.action !== 'void'
      ? facts.get(factKey(row, fact)) : undefined;
    if (row.misconduct_reported === 'reported' && row.action !== 'void'
      && (!!reused === !!row.misconduct_requires_review
        || (row.misconduct_review && reused?.source_batch_id !== row.misconduct_review.source_batch_id)))
      versionConflict('违纪核实状态已变化，请重新上传批次');
    const previous = record?.status === 'current' ? tenths(record.hours) : 0;
    const value = row.action === 'void' ? 0 : tenths(row.credited_hours);
    return { row, record, duration, previous, value, fact, reused };
  });
  const warnings = projectWarnings(daily, entries.map(({ row, duration, previous, value, fact }) =>
    ({ ...row, duration, previous, value, explanation: fact })));
  const byRow = new Map<number, HourWarning[]>();
  for (const warning of warnings) {
    const number = warning.row_numbers![0];
    byRow.set(number, [...(byRow.get(number) ?? []), warning]);
  }
  for (const row of rows) row.warnings = byRow.get(row.row_number) ?? [];
  return { entries, warnings };
}

export async function submitBatch(
  tx: Tx, activity: LoadedActivity, id: string, input: HourBatchSubmit, actor: Actor, now: Date, reauthorize: Reauthorize,
) {
  const batch = await batchForUpdate(tx, id);
  checkVersion(batch.version, input.expected_version);
  if (batch.status !== 'ready') wrongState();
  const summary = batch.summary as unknown as HourBatch;
  const info = batch.metadata as unknown as SourceInfo;
  const source = batch.source_file_id && await tx.hourImportFile.findUnique({
    where: { id: batch.source_file_id }, select: { contents: true },
  });
  if (!source || info.source_hash !== input.source_hash || digest(Buffer.from(source.contents)) !== input.source_hash)
    throw new BusinessError(409, 'version_conflict', '原工作簿摘要已变化，请重新上传');
  if (summary.error_count || !summary.valid_count) invalid('rows', '批次须无行错误并包含有效动作');
  const { entries, warnings } = await checkedRows(tx, batch, activity, now, reauthorize);
  const missing = entries.filter(({ row, fact }) => row.warnings?.length && !fact);
  if (missing.length) {
    const message = '请在原表第 ' + missing[0].row.row_number + ' 行补充时长警告说明，修正后重传';
    throw new BusinessError(422, 'validation_error', message, missing.map(({ row }) => ({
      field: 'remark', row: row.row_number, code: 'validation_error', message: '时长警告须填写说明',
    })));
  }
  await writeRows(tx, id, entries.map(({ row }) => row));
  const next = await tx.hourImportBatch.update({
    where: { id }, data: { status: 'pending_review', version: { increment: 1 }, submitted_at: now,
      submitted_by: actor.account_id, summary: json({ ...summary, ...warningSnapshot(warnings) }),
      metadata: json({ ...info, submitted_by_name: actor.display_name }) },
  });
  await audit(tx, { actor_id: actor.account_id, action: 'submit', resource_type: 'hour_batch', resource_id: id,
    before: { status: batch.status }, after: { status: next.status, valid_count: summary.valid_count } });
  return batchView(next);
}

type Entry = Awaited<ReturnType<typeof checkedRows>>['entries'][number];
function reviewInputs(input: HourBatchReviewDecision, entries: Entry[]) {
  const required = new Set(entries.filter(({ row }) => row.misconduct_requires_review).map(({ row }) => row.row_number));
  const choices = input.misconduct_reviews ?? [];
  const byRow = new Map(choices.map((choice) => [choice.row_number, choice]));
  if (choices.length !== required.size || byRow.size !== choices.length || choices.some((choice) => !required.has(choice.row_number)))
    invalid('misconduct_reviews', '请为所有待核实行各填写一次结论与意见');
  return byRow;
}

async function applyRows(tx: Tx, batch: HourImportBatch, entries: Entry[], input: HourBatchReviewDecision, actor: Actor, now: Date) {
  const reviews = reviewInputs(input, entries);
  const linkedIds = [...reviews.values()].flatMap((choice) => choice.existing_incident_id ? [choice.existing_incident_id] : []);
  const linked = new Map((await tx.incident.findMany({ where: { id: { in: linkedIds } } })).map((row) => [row.id, row]));
  const incidents: Prisma.IncidentCreateManyInput[] = [], facts: Prisma.HourFactReviewCreateManyInput[] = [];
  const additions: Prisma.HourRecordCreateManyInput[] = [];
  const inPlace: { id: string; misconduct_version: number; misconduct_fact: string | null; misconduct_reported: string }[] = [];
  const superseded: string[] = [], voided: string[] = [];
  const changes: object[] = [];
  const recipients = new Map<string, string[]>();
  const info = batch.metadata as unknown as SourceInfo;
  for (const { row, record, fact, reused, previous, value } of entries) {
    const choice = reviews.get(row.row_number);
    const date = new Date(row.service_date + 'T00:00:00Z');
    let review: HourMisconductReview | undefined = reused;
    if (choice) {
      let incident_id: string | undefined;
      if (choice.existing_incident_id) {
        const incident = linked.get(choice.existing_incident_id);
        if (!incident || incident.status !== 'confirmed' || incident.version !== choice.existing_incident_version
          || incident.activity_id !== row.activity_id || incident.student_id !== row.student_id
          || dateText(incident.service_date) !== row.service_date) versionConflict('关联异常状态或归属已变化');
        incident_id = incident.id;
      } else if (choice.decision === 'confirmed') {
        incident_id = randomUUID();
        incidents.push({ id: incident_id, activity_id: row.activity_id, student_id: row.student_id,
          service_date: date, status: 'confirmed', source_type: 'hour_import', facts: fact,
          source_batch_id: batch.id, source_row_number: row.row_number, submitted_by: batch.submitted_by,
          reviewed_by: actor.account_id, review_reason: choice.reason.trim(), created_at: now, updated_at: now });
      }
      review = { decision: choice.decision, reason: choice.reason.trim(), reviewed_by: actor.account_id,
        reviewed_at: now.toISOString(), ...(incident_id && { incident_id }), source_batch_id: batch.id,
        source_row_number: row.row_number, discipline_status: 'not_enabled' };
      facts.push({ activity_id: row.activity_id, student_id: row.student_id, service_date: date,
        fact, result: json(review), incident_id, created_at: now });
    }
    if (review) row.misconduct_review = review;
    const flag = row.misconduct_reported ?? 'not_provided';
    const reported = flag === 'not_provided' ? record?.misconduct_reported ?? flag : flag;
    const detail = flag === 'not_provided' ? record?.misconduct_fact ?? null : flag === 'reported' ? fact : null;
    const changed = !!choice || reported !== (record?.misconduct_reported ?? 'not_provided') ||
      detail !== (record?.misconduct_fact ?? null);
    const metadata = { misconduct_reported: reported, misconduct_fact: detail,
      misconduct_version: (record?.misconduct_version ?? 0) + Number(changed) };
    let nextId: string | undefined;
    if (row.action === 'void') voided.push(record!.id);
    else if (row.action === 'review_only') {
      inPlace.push({ id: record!.id, ...metadata });
      nextId = record!.id;
    } else {
      nextId = randomUUID();
      if (record?.status === 'current') superseded.push(record.id);
      additions.push({ id: nextId, student_id: row.student_id, activity_id: row.activity_id,
        service_date: date, hours: row.credited_hours, status: 'current', version: (record?.version ?? 0) + 1,
        origin_schedule_revision: row.bound_schedule_revision, ...metadata,
        batch_id: batch.id, supersedes_record_id: record?.id, reviewed_at: now, created_at: now, updated_at: now,
        remark: flag === 'reported' ? record?.remark : row.remark || undefined });
    }
    changes.push({ row_number: row.row_number, action: row.action, previous_record_id: record?.id,
      record_id: nextId, origin_schedule_revision: row.bound_schedule_revision,
      previous_hours: hours(previous), credited_hours: hours(value), delta_hours: hours(value - previous),
      ...(review && { misconduct_decision: review.decision, incident_id: review.incident_id }) });
    const lines = recipients.get(row.student_id) ?? [];
    if (row.action !== 'review_only') lines.push(row.service_date + (row.action === 'void'
      ? ' 的时长已撤销（' + hours(previous) + ' 小时）'
      : row.action === 'correct' ? ' 的时长已更正为 ' + hours(value) + ' 小时' : ' 已入账 ' + hours(value) + ' 小时'));
    if (choice?.decision === 'confirmed' && !choice.existing_incident_id) lines.push(row.service_date + ' 的现场异常已有核实结果');
    if (lines.length) recipients.set(row.student_id, lines);
  }
  if (incidents.length) await tx.incident.createMany({ data: incidents });
  if (facts.length) await tx.hourFactReview.createMany({ data: facts });
  for (const [ids, status] of [[superseded, 'superseded'], [voided, 'voided']] as const) {
    if (ids.length) await tx.hourRecord.updateMany({ where: { id: { in: ids } },
      data: { status, version: { increment: 1 }, updated_at: now, ...(status === 'voided' && { voided_by_batch_id: batch.id }) } });
  }
  if (inPlace.length) await tx.$executeRaw`
    UPDATE hour_record AS record SET version = record.version + 1,
      misconduct_fact = changed.misconduct_fact, misconduct_reported = changed.misconduct_reported,
      misconduct_version = changed.misconduct_version, updated_at = ${now}
    FROM jsonb_to_recordset(${JSON.stringify(inPlace)}::jsonb)
      AS changed(id uuid, misconduct_fact text, misconduct_reported text, misconduct_version int)
    WHERE record.id = changed.id`;
  if (additions.length) await tx.hourRecord.createMany({ data: additions });
  await writeRows(tx, batch.id, entries.map(({ row }) => row));
  await enqueueHourNotices(tx, 'hours_result', batch.id, actor.account_id,
    [...recipients].map(([student_id, lines]) => ({
      student_id, activity_id: batch.activity_id, revision: info.schedule_revision, title: info.activity_title + '时长审核结果',
      body: lines.length > 20 ? '你的 ' + lines.length + ' 条时长或异常事项已有审核结果，请查看本人记录。' : lines.join('\n'),
    })));
  return changes;
}

export async function reviewBatch(
  tx: Tx, activity: LoadedActivity, id: string, input: HourBatchReviewDecision, actor: Actor, now: Date, reauthorize: Reauthorize,
) {
  const batch = await batchForUpdate(tx, id);
  checkVersion(batch.version, input.expected_version);
  if (batch.status !== 'pending_review') wrongState();
  if (batch.submitted_by === actor.account_id) denied();
  const summary = batch.summary as unknown as HourBatch;
  let changes: object[] = [];
  let snapshot;
  if (input.decision === 'approved') {
    const { entries, warnings } = await checkedRows(tx, batch, activity, now, reauthorize);
    snapshot = acceptWarnings(input, summary.warning_snapshot_hash, warnings);
    changes = await applyRows(tx, batch, entries, input, actor, now);
  }
  const reason = input.reason?.trim();
  const next = await tx.hourImportBatch.update({
    where: { id }, data: { status: input.decision, reviewed_by: actor.account_id, reviewed_at: now,
      decision_reason: reason, version: { increment: 1 }, ...(snapshot && { summary: json({ ...summary, ...snapshot }) }) },
  });
  await audit(tx, { actor_id: actor.account_id, action: input.decision === 'approved' ? 'approve' : 'reject',
    resource_type: 'hour_batch', resource_id: id, reason, before: { status: batch.status },
    after: { status: next.status, warning_snapshot_hash: snapshot?.warning_snapshot_hash, changes } });
  return batchView(next);
}

export async function requestVoid(
  tx: Tx, activity: LoadedActivity, id: string, input: ReasonAction, actor: Actor, now: Date, reauthorize: Reauthorize,
) {
  const reason = input.reason.trim();
  if (!reason) invalid('reason', '请说明撤销原因');
  const original = await tx.hourRecord.findUnique({
    where: { id }, include: { student: { include: { account: { select: { display_name: true } } } } },
  });
  if (!original || original.activity_id !== activity.id) invisible();
  const identity = { student_id: original.student_id, activity_id: original.activity_id, service_date: dateText(original.service_date) };
  await lockLedger(tx, [identity]);
  await reauthorize();
  checkVersion(original.version, input.expected_version);
  if (original.status !== 'current') wrongState();
  if (await tx.hourImportBatch.findFirst({ where: { void_record_id: id, status: 'pending_review' }, select: { id: true } }))
    throw new BusinessError(409, 'conflict', '该记录已有待审撤销申请');
  const batchId = randomUUID(), previous = original.hours.toFixed(1);
  const title = activity.revisions.find((row) => row.revision === original.origin_schedule_revision)?.content as
    { title?: string } | undefined;
  const row: HourRow = {
    row_number: 2, student_id: original.student_id, student_no: original.student.student_no,
    student_name: original.student.account.display_name, service_date: identity.service_date, activity_code: activity.activity_code,
    action: 'void', existing_record_id: id, existing_version: original.version, remark: reason, previous_hours: previous,
    credited_hours: '0.0', delta_hours: '-' + previous, bound_schedule_revision: original.origin_schedule_revision,
    misconduct_reported: 'not_provided', previous_misconduct_reported: original.misconduct_reported as HourRow['misconduct_reported'],
    misconduct_requires_review: false, misconduct_version: original.misconduct_version, errors: [], warnings: [],
  };
  const saved = await tx.hourImportBatch.create({ data: {
    id: batchId, activity_id: activity.id, void_record_id: id, submitted_by: actor.account_id, validation_by: actor.account_id,
    mode: 'void', status: 'pending_review', submitted_at: now,
    metadata: json({ batch_code: 'H-' + batchId, activity_code: activity.activity_code,
      activity_title: title?.title ?? activity.activity_code, source_description: reason, submitted_by_name: actor.display_name }),
    summary: json({ ...emptySummary(), progress: 100, row_count: 1, valid_count: 1, skipped_count: 0, error_count: 0,
      template_structure: 'system_void', projected_delta_hours: row.delta_hours, misconduct_review_required_count: 0,
      misconduct_flagged_count: 0, review_only_count: 0 }),
    rows: { create: { row_number: 2, action: row.action, needs_review: false, detail: json(row) } },
  } });
  await audit(tx, { actor_id: actor.account_id, action: 'submit', resource_type: 'hour_batch', resource_id: batchId,
    reason, after: { status: saved.status, action: 'void', record_id: id } });
  return batchView(saved);
}
