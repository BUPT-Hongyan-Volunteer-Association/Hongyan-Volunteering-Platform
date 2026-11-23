import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { createApp } from '../dist/app.js';
import { validate } from '../dist/activities/validation.js';
import { Database } from '../dist/database.js';
import { authorizeHourLedger, readHourLedger } from '../dist/hours/read-ledger.js';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { browser } from './api-client.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { ledgerActivity, ledgerDay, ledgerWorkbook } from './hour-ledger-fixture.mjs';

const collection = (activity) => '/organizer/activities/' + activity.id + '/hour-imports';
const detail = (batch) => '/hour-imports/' + batch.id;
const groupPath = '/organizer/hour-correction-groups';
const groupDecision = (group) => '/admin/hour-correction-groups/' + group.id + '/decision';
const decision = (batch) => '/admin' + detail(batch) + '/decision';
const approved = (batch, extra) => ({ expected_version: batch.version, decision: 'approved', ...extra });

function result(response, expected) {
  assert.equal(response.status, expected, JSON.stringify(response));
  return response.data;
}

async function preview(owner, activity, rows, mode = 'new') {
  const form = new FormData();
  form.set('mode', mode);
  form.set('file', new Blob([ledgerWorkbook(activity, rows)]), '结算验收.xlsx');
  const response = await owner.raw(collection(activity), { method: 'POST', body: form, headers: { 'Idempotency-Key': randomUUID() } });
  const uploaded = result({ status: response.status, ...await response.json() }, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const batch = result(await owner.request(detail(uploaded)), 200);
    if (batch.status !== 'validating') return batch;
    await delay(40);
  }
  assert.fail('导入未完成');
}

async function submit(owner, batch) {
  return result(await owner.write('POST', detail(batch) + '/submit',
    { expected_version: batch.version, source_hash: batch.source_hash }), 200);
}
async function myHours(client, extra = '') {
  const value = result(await client.request('/me/hours' + extra), 200);
  return validate('hour_record_page', value);
}
async function myDay(client, day, history = false) {
  return myHours(client, '?from_date=' + day + '&to_date=' + day + '&include_history=' + history);
}

function pair(source, target, activity, day, hours = source.credited_hours) {
  return { source_record_id: source.id, expected_source_version: source.version,
    target_student_no: target.student_no, target_student_name: target.account.display_name, target_activity_id: activity.id,
    target_service_date: day, target_schedule_revision: 1, credited_hours: hours, reason: '核对后重新登记' };
}

async function compareExportRows(db, client, path, scope, filters) {
  validate('export_input', { ...scope, ...filters });
  const actor = result(await client.request('/me'), 200);
  const snapshot = await db.$transaction((tx) => readHourLedger(tx, actor, scope, filters),
    { isolationLevel: 'RepeatableRead' });
  const readPage = async (page) => validate('hour_record_page', result(await client.request(
    path + '?' + new URLSearchParams({ ...filters, page: String(page), page_size: '1' }),
  ), 200));
  const first = await readPage(1);
  const pages = [first];
  for (let page = 2; page <= first.total; page++) pages.push(await readPage(page));
  assert.deepEqual(snapshot.items, pages.flatMap((page) => page.items));
  for (const page of pages) {
    assert.equal(page.total, snapshot.total);
    assert.equal(page.total_hours, snapshot.total_hours);
  }
  return snapshot;
}

test('独立 PostgreSQL 时长账务、警告、并发与更正结案', { timeout: 90000 }, async (t) => {
  Logger.overrideLogger(['error']);
  const staffPassword = 'H1' + randomUUID(), adminPassword = 'H2' + randomUUID(), password = 'H3' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword, DEMO_ADMIN_PASSWORD: adminPassword });
  const db = new Database(), app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl() + '/api/v1';
    const owner = browser(origin), teacher = browser(origin), admin = browser(origin), alice = browser(origin), bob = browser(origin);
    await Promise.all([
      owner.signIn('0000000002', '000002', password),
      alice.signIn('0000000001', '000001', password),
      bob.signIn('0000000003', '000003', password),
      teacher.signIn('demo.teacher', staffPassword), admin.signIn('demo.admin', adminPassword),
    ]);
    const [a, o, b] = await db.student.findMany({ orderBy: { student_no: 'asc' }, take: 3, include: { account: true } });
    const activity = await ledgerActivity(db, o.account_id, '本活动时长');
    const other = await ledgerActivity(db, o.account_id, '跨活动时长');
    const worker = app.get(NoticeWorker);
    let source, crossRepair, wrong, missing;

    await t.test('校验摘要、失权送审、并发批准与通知回放', async () => {
      const day = ledgerDay();
      const batch = await preview(owner, activity, [{ student: a, day }]);
      assert.equal(batch.status, 'ready');
      assert.equal((await myDay(alice, day)).total_hours, '0.0');
      const path = detail(batch) + '/submit', body = { expected_version: batch.version, source_hash: batch.source_hash };
      assert.equal((await owner.write('POST', path, { ...body, source_hash: 'stale' })).status, 409);
      const memberKey = { activity_id: activity.id, account_id: o.account_id };
      await db.activityMember.delete({ where: { activity_id_account_id: memberKey } });
      assert.equal((await owner.write('POST', path, body)).status, 404);
      await db.activityMember.create({ data: { ...memberKey, member_role: 'owner' } });
      const key = randomUUID();
      const pending = result(await owner.write('POST', path, body, key), 200);
      assert.deepEqual(result(await owner.write('POST', path, body, key), 200), pending);
      assert.equal(pending.status, 'pending_review');
      assert.equal(pending.submitted_by_name, o.account.display_name);
      assert.equal((await myDay(alice, day)).total_hours, '0.0');
      assert.equal((await bob.request(detail(pending) + '/rows')).status, 404);
      assert.equal((await alice.request(detail(pending) + '/rows')).status, 403);
      assert.equal((await alice.request('/admin/students/' + b.id + '/hours')).status, 403);
      assert.equal(result(await teacher.request('/admin/hour-imports?status=pending_review'), 200).items[0].id, batch.id);
      const api = decision(pending), input = approved(pending), approveKey = randomUUID();
      const [left, right] = await Promise.all([teacher.write('POST', api, input, approveKey), admin.write('POST', api, input, approveKey)]);
      assert.deepEqual([left.status, right.status].sort(), [200, 409]);
      const winner = left.status === 200 ? teacher : admin;
      const saved = result(left.status === 200 ? left : right, 200);
      assert.deepEqual(result(await winner.write('POST', api, input, approveKey), 200), saved);
      const { items, total_hours } = await myDay(alice, day);
      assert.equal(total_hours, '2.0');
      assert.equal(items.length, 1);
      source = items[0];
      assert.equal(source.batch_id, pending.id);
      assert.equal(source.origin_schedule_revision, 1);
      assert.equal((await myDay(bob, day)).total_hours, '0.0');
      assert.equal(await db.auditEvent.count({ where: { resource_id: pending.id, action: 'approve' } }), 1);
      assert.equal(await db.notificationEvent.count({ where: { resource_id: pending.id, event_type: 'hours_result' } }), 1);
      const duplicate = await preview(owner, activity, [{ student: a, day }]);
      assert.equal(duplicate.valid_count, 0);
      assert.equal((await owner.write('POST', detail(duplicate) + '/submit',
        { expected_version: duplicate.version, source_hash: duplicate.source_hash })).status, 422);

      const recruit = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });
      const application = result(await alice.write('POST', '/activities/' + recruit.id + '/registrations', {}), 201);
      const recruitDecision = { expected_version: application.version, decision: 'accepted' }, recruitKey = randomUUID();
      const recruitPath = '/organizer/registrations/' + application.id + '/decision';
      const accepted = result(await owner.write('POST', recruitPath, recruitDecision, recruitKey), 200);
      assert.deepEqual(result(await owner.write('POST', recruitPath, recruitDecision, recruitKey), 200), accepted);
      for (let i = 0; i < 3; i++) await worker.drain();
      for (const kind of ['hours_result', 'result']) {
        const page = result(await alice.request('/me/notices?notice_kind=' + kind), 200);
        assert.equal(page.total, 1);
      }
    });

    await t.test('本人反馈、跨人修复与分别结案', async () => {
      const day = ledgerDay();
      wrong = result(await alice.write('POST', '/me/appeals', {
        target_type: 'hours', target_id: source.id, description: '实际未参加，申请核实错记',
      }), 201);
      const claim = { target_type: 'missing_hours', activity_id: activity.id, service_date: day,
        requested_hours: '2.0', description: '未报名，当天现场协助资料归档' };
      const duplicate = await Promise.all([bob.write('POST', '/me/appeals', claim), bob.write('POST', '/me/appeals', claim)]);
      assert.deepEqual(duplicate.map((r) => r.status).sort(), [201, 409]);
      missing = result(duplicate.find((r) => r.status === 201), 201);
      assert.equal((await alice.write('POST', '/me/appeals', { ...claim, service_date: ledgerDay(-3) })).status, 422);
      assert.equal((await bob.write('POST', '/me/appeals', { target_type: 'hours', target_id: source.id, description: '试读' })).status, 404);
      const own = result(await owner.request('/organizer/activities/' + activity.id + '/appeals'), 200);
      assert.deepEqual(new Set(own.items.map((row) => row.id)), new Set([wrong.id, missing.id]));
      const data = { items: [pair(source, b, activity, day)], reason: '已核对学生记录', appeal_id: wrong.id };
      crossRepair = validate('hour_correction_group', result(await owner.write('POST', groupPath, data), 201));
      assert.equal((await bob.request('/hour-correction-groups/' + crossRepair.id)).status, 404);
      assert.equal((await myDay(alice, day)).total_hours, '2.0');
      assert.equal((await myDay(bob, day)).total_hours, '0.0');
      const close = (appeal, action, extra = {}) => teacher.write('POST', '/admin/appeals/' + appeal.id + '/decision', {
        expected_version: appeal.version, decision: 'resolved', resolution_action: action, reason: b.account.display_name + ' 由老师核实',
        correction_group_id: crossRepair.id, ...extra,
      });
      assert.equal((await close(wrong, 'rekey_hours')).status, 422);
      const repaired = result(await teacher.write('POST', groupDecision(crossRepair), approved(crossRepair)), 200);
      assert.equal(repaired.status, 'approved');
      const target = repaired.items[0].new_record_id;
      assert.equal((await close(wrong, 'rekey_hours', { result_hour_record_ids: [target] })).status, 422);
      assert.deepEqual(result(await close(wrong, 'rekey_hours'), 200).result_hour_record_ids, [source.id]);
      assert.deepEqual(result(await close(missing, 'add_missing_hours'), 200).result_hour_record_ids, [target]);
      assert.equal((await myDay(alice, day)).total_hours, '0.0');
      const history = (await myDay(alice, day, true)).items;
      assert.deepEqual(history.map(({ id, status, batch_id, voided_by_group_id }) => [id, status, batch_id, voided_by_group_id]),
        [[source.id, 'voided', source.batch_id, crossRepair.id]]);
      const ownNow = await myDay(bob, day);
      assert.equal(ownNow.total_hours, '2.0');
      assert.equal(ownNow.items[0].id, target);
      assert.equal(ownNow.items[0].correction_group_id, crossRepair.id);
      const rekeyFilter = { from_date: day, to_date: day, include_history: true };
      const rekeyRows = await compareExportRows(db, owner, '/organizer/activities/' + activity.id + '/hours',
        { type: 'activity_hours', activity_id: activity.id }, rekeyFilter);
      assert.equal(rekeyRows.total_hours, '2.0');
      assert.deepEqual(rekeyRows.items.map(({ id, status }) => [id, status]), [[target, 'current'], [source.id, 'voided']]);
      const aExport = await compareExportRows(db, alice, '/me/hours', { type: 'my_hours' }, rekeyFilter);
      const bExport = await compareExportRows(db, teacher, '/admin/students/' + b.id + '/hours',
        { type: 'admin_student_hours', student_id: b.id }, rekeyFilter);
      assert.deepEqual(aExport.items.map((row) => row.id), [source.id]);
      assert.deepEqual(bExport.items.map((row) => row.id), [target]);
      const r1 = result(await alice.request('/me/appeals?appeal_id=' + wrong.id), 200).items[0];
      const r2 = result(await bob.request('/me/appeals?appeal_id=' + missing.id), 200).items[0];
      assert.deepEqual([r1.resolution, r2.resolution], ['本人错记时长已撤销。', '本人 2.0 小时已补记。']);
      assert.doesNotMatch(JSON.stringify(r1), new RegExp(target + '|' + b.account.display_name));
      assert.equal(result(await alice.request('/me/appeals?appeal_id=' + missing.id), 200).total, 0);
      await worker.drain();
      const aNotices = result(await alice.request('/me/notices?notice_kind=hours_result'), 200);
      const bNotices = result(await bob.request('/me/notices?notice_kind=hours_result'), 200);
      assert.ok(aNotices.items.some((notice) => notice.body.includes('已撤销')));
      assert.ok(bNotices.items.some((notice) => notice.body.includes('已补记')));
      assert.doesNotMatch(JSON.stringify(aNotices), /已补记|同学乙/);
      assert.doesNotMatch(JSON.stringify(bNotices), /已撤销|体验学生/);
      const missedDay = ledgerDay(3);
      const missed = result(await bob.write('POST', '/me/appeals', { ...claim, service_date: missedDay }), 201);
      const supplemental = await submit(owner, await preview(owner, activity, [{ student: b, day: missedDay }]));
      const closeSupplemental = () => teacher.write('POST', '/admin/appeals/' + missed.id + '/decision', {
        expected_version: missed.version, decision: 'resolved', resolution_action: 'add_missing_hours',
        reason: '已核对真实服务', correction_batch_id: supplemental.id,
      });
      assert.equal((await closeSupplemental()).status, 422);
      result(await teacher.write('POST', decision(supplemental), approved(supplemental)), 200);
      const page = await myDay(bob, missedDay);
      assert.deepEqual(result(await closeSupplemental(), 200).result_hour_record_ids, [page.items[0].id]);
    });

    await t.test('审核前并发改变累计，409 快照和 422 依据分开，保留原行核实', async () => {
      const day = ledgerDay(5);
      const first = await submit(owner, await preview(owner, other, [{ student: a, day, hours: '22.0' }]));
      result(await teacher.write('POST', decision(first), approved(first)), 200);
      const pending = await submit(owner, await preview(owner, activity, [{ student: a, day, flag: '有', note: '测试现场事实甲' }]));
      assert.equal(pending.warnings.length, 0);
      const update = await submit(owner, await preview(owner, other, [{ student: a, day, hours: '23.0' }], 'correction'));
      result(await teacher.write('POST', decision(update), approved(update)), 200);
      const review = { row_number: 2, decision: 'confirmed', reason: '核对签到与服务记录' };
      const conflict = await teacher.write('POST', decision(pending), approved(pending, {
        warning_snapshot_hash: pending.warning_snapshot_hash, misconduct_reviews: [review],
      }));
      assert.equal(conflict.status, 409);
      assert.equal(conflict.code, 'warning_review_required');
      assert.equal(conflict.context.warnings[0].projected_daily_hours, '25.0');
      assert.equal(await db.incident.count({ where: { source_batch_id: pending.id } }), 0);
      assert.equal((await teacher.write('POST', decision(pending), approved(pending, {
        warning_snapshot_hash: conflict.context.warning_snapshot_hash, misconduct_reviews: [review],
      }))).status, 422);
      const accepted = result(await teacher.write('POST', decision(pending), approved(pending, {
        warning_snapshot_hash: conflict.context.warning_snapshot_hash, reason: '已核对服务跨度', misconduct_reviews: [review],
      })), 200);
      const rows = result(await teacher.request(detail(accepted) + '/rows'), 200).items;
      assert.equal(rows[0].misconduct_review.decision, 'confirmed');
      const incident = result(await alice.request('/me/incidents'), 200).items.find((item) => item.source_batch_id === pending.id);
      assert.equal(incident.service_date, day);
      assert.equal(incident.occurred_at, undefined);
      assert.equal(await db.auditEvent.count({ where: { resource_id: accepted.id, action: 'approve' } }), 1);
      assert.doesNotMatch(JSON.stringify(await myDay(alice, day)), /测试现场事实甲/);

      const decreases = await submit(owner, await preview(owner, other, [{ student: a, day, hours: '21.0' }], 'correction'));
      assert.equal(decreases.warnings.length, 0);
      const verification = await submit(owner, await preview(owner, activity, [{ student: a, day, flag: '有', note: '测试现场事实乙' }]));
      assert.equal(verification.review_only_count, 1);
      assert.equal(verification.projected_delta_hours, '0.0');
      const before = (await myDay(alice, day)).items.find((row) => row.activity_id === activity.id);
      result(await teacher.write('POST', decision(decreases), approved(decreases)), 200);
      const stale = await teacher.write('POST', decision(verification), approved(verification, {
        warning_snapshot_hash: verification.warning_snapshot_hash, misconduct_reviews: [review],
      }));
      assert.equal(stale.code, 'warning_review_required');
      assert.deepEqual(stale.context.warnings, []);
      result(await teacher.write('POST', decision(verification), approved(verification, {
        warning_snapshot_hash: stale.context.warning_snapshot_hash,
        misconduct_reviews: [{ ...review, decision: 'rejected' }],
      })), 200);
      const after = (await myDay(alice, day)).items.find((row) => row.activity_id === activity.id);
      assert.equal(after.id, before.id);
      assert.equal(after.credited_hours, before.credited_hours);
      assert.equal(after.batch_id, before.batch_id);
      assert.equal(await db.incident.count({ where: { activity_id: activity.id, student_id: a.id } }), 1);
      const repeat = await preview(owner, activity, [{ student: a, day, flag: '有', note: '测试现场事实乙' }]);
      assert.equal(repeat.valid_count, 0);
      const returned = result(await teacher.request(detail(repeat) + '/rows'), 200).items[0];
      assert.equal(returned.misconduct_review.source_batch_id, verification.id);
      const appeal = { target_type: 'incident', target_id: incident.id, description: '请复核本人现场记录' };
      const appealKey = randomUUID();
      const firstAppeal = result(await alice.write('POST', '/me/appeals', appeal, appealKey), 201);
      result(await teacher.write('POST', '/admin/incidents/' + incident.id + '/revoke',
        { expected_version: incident.version, reason: '后续复核已撤销' }), 200);
      assert.deepEqual(result(await alice.write('POST', '/me/appeals', appeal, appealKey), 201), firstAppeal);
      assert.equal((await alice.write('POST', '/me/appeals', appeal)).status, 404);
      assert.equal((await myDay(alice, day)).total_hours, '23.0');
    });

    await t.test('整组目标冲突回滚，活动范围收回后整组不可见', async () => {
      const days = [ledgerDay(7), ledgerDay(8)];
      const input = days.map((day) => ({ student: a, day }));
      const original = await submit(owner, await preview(owner, activity, input));
      result(await teacher.write('POST', decision(original), approved(original)), 200);
      const originals = await Promise.all(days.map(async (day) => (await myDay(alice, day)).items[0]));
      const pairs = originals.map((record, idx) => pair(record, b, other, days[idx]));
      const payload = { items: pairs, reason: '跨活动核对错账' };
      const repeatedTarget = await owner.write('POST', groupPath, {
        ...payload, items: [pairs[0], { ...pairs[1], target_service_date: pairs[0].target_service_date }],
      });
      assert.equal(repeatedTarget.status, 409);
      assert.equal(repeatedTarget.code, 'target_key_conflict');
      const idempotency = randomUUID();
      const group = result(await owner.write('POST', groupPath, payload, idempotency), 201);
      const member = { activity_id: other.id, account_id: o.account_id };
      await db.activityMember.delete({ where: { activity_id_account_id: member } });
      const groupUrl = '/hour-correction-groups/' + group.id;
      assert.equal((await owner.request(groupUrl)).status, 404);
      assert.equal(result(await owner.request('/organizer/activities/' + activity.id + '/hour-correction-groups'), 200)
        .items.some((item) => item.id === group.id), false);
      assert.equal((await owner.write('POST', groupUrl + '/withdraw', { expected_version: group.version, reason: '撤回' })).status, 404);
      assert.equal((await owner.write('POST', groupPath, payload, idempotency)).status, 404);
      await db.activityMember.create({ data: { ...member, member_role: 'owner' } });
      const occupier = await submit(owner, await preview(owner, other, [{ student: b, day: days[1], hours: '1.0' }]));
      result(await teacher.write('POST', decision(occupier), approved(occupier)), 200);
      const attempt = await teacher.write('POST', groupDecision(group), approved(group));
      assert.equal(attempt.status, 409);
      assert.equal(attempt.code, 'target_key_conflict');
      assert.equal(result(await teacher.request(groupUrl), 200).status, 'pending_review');
      for (const day of days) assert.equal((await myDay(alice, day)).total_hours, '2.0');
      assert.equal((await myDay(bob, days[0])).total_hours, '0.0');
      assert.equal((await myDay(bob, days[1])).total_hours, '1.0');
      assert.equal(await db.auditEvent.count({ where: { resource_id: group.id, action: 'approve' } }), 0);
      assert.equal(await db.notificationEvent.count({ where: { resource_id: group.id } }), 0);
      assert.equal(result(await owner.write('POST', groupUrl + '/withdraw',
        { expected_version: group.version, reason: '目标记录已存在' }), 200).status, 'withdrawn');
    });

    await t.test('更正保留历史，三种读取和无分页的导出读取一致，撤销与驳回', async () => {
      const days = [ledgerDay(10), ledgerDay(11)];
      const pending = await submit(owner, await preview(owner, activity, days.map((day) => ({ student: a, day, hours: '501.0' }))));
      result(await teacher.write('POST', decision(pending), approved(pending, { reason: '专项核对并接受警告', warning_snapshot_hash: pending.warning_snapshot_hash })), 200);
      const corrected = await submit(owner, await preview(owner, activity, [{ student: a, day: days[0], hours: '502.0' }], 'correction'));
      result(await teacher.write('POST', decision(corrected), approved(corrected, { reason: '核对准确小时数', warning_snapshot_hash: corrected.warning_snapshot_hash })), 200);
      const dateFilters = { from_date: days[1], to_date: days[0], include_history: true };
      const params = new URLSearchParams({ ...dateFilters, page_size: '1' });
      const [p1, p2] = await Promise.all([myHours(alice, '?' + params), myHours(alice, '?' + params + '&page=2')]);
      assert.deepEqual([p1.total_hours, p2.total_hours, p1.total], ['1003.0', '1003.0', 3]);
      assert.equal(p2.items[0].status, 'superseded');
      assert.equal(p1.items[0].supersedes_record_id, p2.items[0].id);
      const activityPath = '/organizer/activities/' + activity.id + '/hours';
      const activityScope = { type: 'activity_hours', activity_id: activity.id };
      const unpaged = await compareExportRows(db, alice, '/me/hours', { type: 'my_hours' }, dateFilters);
      const activityHours = await compareExportRows(db, owner, activityPath, activityScope, dateFilters);
      const staffHours = await compareExportRows(db, teacher, '/admin/students/' + a.id + '/hours',
        { type: 'admin_student_hours', student_id: a.id }, dateFilters);
      assert.deepEqual(activityHours, unpaged);
      assert.deepEqual(staffHours, unpaged);
      assert.deepEqual([unpaged.total_hours, unpaged.items.map((row) => row.status)], ['1003.0', ['current', 'superseded', 'current']]);
      assert.deepEqual([...new Set(unpaged.items.map((row) => row.student_no))], ['0000000001']);
      assert.equal((await alice.request('/me/hours?from_date=2026-02-30')).status, 422);
      const organizer = result(await owner.request('/me'), 200);
      const reauthorize = () => db.$transaction((tx) => authorizeHourLedger(tx, organizer, activityScope));
      assert.deepEqual(await reauthorize(), { activity_id: activity.id });
      const member = await db.activityMember.delete({
        where: { activity_id_account_id: { activity_id: activity.id, account_id: o.account_id } },
      });
      try {
        await assert.rejects(reauthorize, (error) => error.getStatus?.() === 404);
        assert.equal((await owner.request(activityPath)).status, 404);
      } finally {
        await db.activityMember.create({ data: member });
      }
      const target = p1.items[0];
      const voidPath = '/organizer/hour-records/' + target.id + '/void-requests';
      const voidArgs = { expected_version: target.version, reason: '整笔误录' };
      const revoke = result(await owner.write('POST', voidPath, voidArgs), 201);
      assert.equal((await owner.write('POST', voidPath, voidArgs)).status, 409);
      assert.equal((await myDay(alice, days[0])).total_hours, '502.0');
      const denied = result(await teacher.write('POST', decision(revoke), {
        expected_version: revoke.version, decision: 'rejected', reason: '再次确认再撤销',
      }), 200);
      assert.equal(denied.status, 'rejected');
      assert.equal((await myDay(alice, days[0])).total_hours, '502.0');
      const again = result(await owner.write('POST', voidPath, voidArgs), 201);
      result(await teacher.write('POST', decision(again), approved(again)), 200);
      const history = await myDay(alice, days[0], true);
      assert.equal(history.total_hours, '0.0');
      assert.deepEqual(history.items.map((row) => row.status), ['voided', 'superseded']);
      assert.equal(history.items[0].voided_by_batch_id, again.id);
      const restored = await submit(owner, await preview(owner, activity, [{ student: a, day: days[0], hours: '2.0' }], 'correction'));
      assert.equal(restored.projected_delta_hours, '2.0');
      result(await teacher.write('POST', decision(restored), approved(restored)), 200);
      assert.equal((await myDay(alice, days[0])).items[0].supersedes_record_id, target.id);
      const dual = browser(origin);
      await dual.signIn('demo.dual', staffPassword);
      const ownBatch = await submit(dual, await preview(dual, activity, [{ student: b, day: ledgerDay(13) }]));
      assert.equal((await dual.write('POST', decision(ownBatch), approved(ownBatch))).status, 403);
    });

    await t.test('送审时按锁内累计复核空备注，冻结最新批次和行警告', async () => {
      const day = ledgerDay(18), target = await ledgerActivity(db, o.account_id, '送审重新核账');
      await db.registration.create({ data: { activity_id: target.id, student_id: a.id, status: 'accepted',
        submitted_at: new Date(ledgerDay(20)) } });
      const clean = await preview(owner, target, [{ student: a, day, note: '' }]);
      const explained = await preview(owner, target, [{ student: a, day, note: '另参加晚场' }]);
      assert.equal(clean.warnings.length, 0);
      const extra = await submit(owner, await preview(owner, other, [{ student: a, day, hours: '23.0' }]));
      result(await teacher.write('POST', decision(extra), approved(extra)), 200);
      const refused = await owner.write('POST', detail(clean) + '/submit',
        { expected_version: clean.version, source_hash: clean.source_hash });
      assert.equal(refused.status, 422);
      assert.equal(refused.details[0].row, 2);
      assert.equal(result(await owner.request(detail(clean)), 200).status, 'ready');
      const pending = await submit(owner, explained);
      assert.equal(pending.warnings[0].projected_daily_hours, '25.0');
      const row = result(await owner.request(detail(pending) + '/rows'), 200).items[0];
      assert.deepEqual(row.warnings, pending.warnings);
      assert.notEqual(explained.warning_snapshot_hash, pending.warning_snapshot_hash);
    });

    await t.test('无来源旧账保留原值，不参与查账、导出、当日警告和同键正式入账', async () => {
      const day = ledgerDay(19);
      // 在独立测试库还原新增约束之前已有一条旧记录的升级状态。
      const legacy = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE hour_record DROP CONSTRAINT hour_record_requires_origin');
        const old = await tx.hourRecord.create({ data: { activity_id: activity.id, student_id: b.id,
          service_date: new Date(day), hours: '30.0', version: 1, status: 'current',
          origin_schedule_revision: 1, misconduct_reported: 'none', misconduct_version: 0 } });
        await tx.$executeRawUnsafe('ALTER TABLE hour_record ADD CONSTRAINT hour_record_requires_origin CHECK (num_nonnulls(batch_id, correction_group_id) = 1) NOT VALID');
        return old;
      });
      assert.equal((await myDay(bob, day, true)).total, 0);
      const snapshot = await compareExportRows(db, bob, '/me/hours', { type: 'my_hours' },
        { from_date: day, to_date: day, include_history: true });
      assert.equal(snapshot.total_hours, '0.0');
      const pending = await submit(owner, await preview(owner, activity, [{ student: b, day }]));
      assert.equal(pending.warnings.length, 0);
      result(await teacher.write('POST', decision(pending), approved(pending)), 200);
      const visible = await myDay(bob, day, true);
      assert.equal(visible.total, 1);
      assert.equal(visible.total_hours, '2.0');
      assert.equal(visible.items[0].batch_id, pending.id);
      assert.deepEqual(await db.hourRecord.findUniqueOrThrow({ where: { id: legacy.id } }), legacy);
    });

    await t.test('审批在等待账务锁期间失去审核角色时拒绝入账', async () => {
      const day = ledgerDay(14);
      const batch = await submit(owner, await preview(owner, activity, [{ student: a, day }]));
      const account = await db.account.findUniqueOrThrow({ where: { username: 'demo.teacher' } });
      const ready = Promise.withResolvers(), release = Promise.withResolvers();
      const lock = db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT key FROM hour_ledger_lock WHERE key = ${'hours/day/' + a.id + '/' + day} FOR UPDATE`;
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const pending = teacher.write('POST', decision(batch), approved(batch));
      try {
        let waiting = false;
        for (let i = 0; i < 80 && !waiting; i++) {
          const [state] = await db.$queryRaw`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND wait_event_type = 'Lock' AND query LIKE '%SELECT key FROM hour_ledger_lock WHERE key = ANY%') AS blocked`;
          waiting = state.blocked;
          if (!waiting) await delay(15);
        }
        assert.ok(waiting, '审批须等待同一学生日期的账务锁');
        await db.roleGrant.deleteMany({ where: { account_id: account.id, role: 'reviewer' } });
      } finally {
        release.resolve();
        await lock;
      }
      assert.equal((await pending).status, 403);
      assert.equal((await myDay(alice, day)).total_hours, '0.0');
      assert.equal((await db.hourImportBatch.findUniqueOrThrow({ where: { id: batch.id } })).status, 'pending_review');
    });

  } finally {
    await app.close();
    await db.$disconnect();
  }
});
