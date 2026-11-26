import { pollUntil } from './poll-until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { audit } from '../dist/audit.js';
import { readXlsxSheet } from '../dist/students/xlsx.js';
import { browser } from './api-client.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { ledgerActivity, ledgerDay, ledgerWorkbook, seedApprovedHours } from './hour-ledger-fixture.mjs';

function result(response, expected) {
  assert.equal(response.status, expected, JSON.stringify(response));
  return response.data;
}
async function sheetCells(buffer, name) {
  return (await readXlsxSheet(buffer, name)).rows.map((row) => row.cells);
}
async function sheetRows(buffer, name) {
  const sheet = await readXlsxSheet(buffer, name);
  return sheet.rows.map((row) => {
    const values = [];
    for (const cell of row.cells) values[cell.column] = cell.text;
    return values.map((value) => value ?? '');
  });
}
async function createExport(client, body) {
  return result(await client.write('POST', '/exports', body, randomUUID()), 202);
}
async function waitExport(client, id) {
  const response = await pollUntil(() => client.request('/exports/' + id),
    item => item.status !== 200 || ['ready', 'failed', 'expired'].includes(item.data.status), '导出');
  return response.status === 200 ? response.data : response;
}
async function download(client, id) {
  const response = await client.raw('/exports/' + id + '/download');
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}
async function rowsWithoutHeader(buffer, name) {
  return (await sheetRows(buffer, name)).slice(1);
}

test('业务导出、受控下载与审计查询', { timeout: 120000 }, async (t) => {
  Logger.overrideLogger(['error']);
  const staffPassword = 'E1' + randomUUID(), adminPassword = 'E2' + randomUUID(), password = 'E3' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword, DEMO_ADMIN_PASSWORD: adminPassword });
  const db = new Database();
  let app;
  try {
    app = await createApp();
    await checkExports(t, db, app, { staffPassword, adminPassword, password });
  } finally {
    try { await app?.close(); } finally { await db.$disconnect(); }
  }
});

async function checkExports(t, db, app, { staffPassword, adminPassword, password }) {
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()) + '/api/v1';
  const owner = browser(origin), other = browser(origin), teacher = browser(origin),
    admin = browser(origin), alice = browser(origin), bob = browser(origin);
  await Promise.all([
    owner.signIn('0000000002', '000002', password),
    other.signIn('0000000003', '000003', password),
    teacher.signIn('demo.teacher', staffPassword),
    admin.signIn('demo.admin', adminPassword),
    alice.signIn('0000000001', '000001', password),
    bob.signIn('0000000004', '000004', password),
  ]);
  const ownerAccount = await db.account.findUniqueOrThrow({ where: { username: '0000000002' } });
  const aliceStudent = await db.student.findUniqueOrThrow({ where: { student_no: '0000000001' } });
  const teacherAccount = await db.account.findUniqueOrThrow({ where: { username: 'demo.teacher' } });
  const bobStudent = await db.student.findUniqueOrThrow({ where: { student_no: '0000000004' } });

  await t.test('新实例保留运行中的任务，并在后续轮询时接管已超时任务', async () => {
    const running = await db.exportJob.create({
      data: {
        actor_id: teacherAccount.id, type: 'admin_students',
        scope: { type: 'admin_students' }, status: 'running',
      },
    });
    const second = await createApp();
    await second.listen(0, '127.0.0.1');
    try {
      await delay(300);
      assert.equal((await db.exportJob.findUniqueOrThrow({ where: { id: running.id } })).status, 'running');
      await db.exportJob.update({
        where: { id: running.id }, data: { updated_at: new Date(Date.now() - 31 * 60_000) },
      });
      assert.equal((await waitExport(teacher, running.id)).status, 'ready');
    } finally {
      await second.close();
      await db.exportJob.delete({ where: { id: running.id } });
    }
  });

  const synthetic = [];
  for (let index = 0; index < 25; index++) {
    const username = '00000031' + String(index).padStart(2, '0');
    synthetic.push(await db.account.create({
      data: {
        username,
        display_name: '合成学生' + String(index).padStart(2, '0'),
        password_hash: 'fixture',
        must_change_password: false,
        roles: { create: { role: 'student' } },
        student: { create: { student_no: username } },
      },
      include: { student: true },
    }));
  }

  const rosterActivity = await ledgerActivity(db, ownerAccount.id, '名单导出活动');
  const roster = [];
  for (const [index, account] of synthetic.entries()) {
    roster.push(await db.registration.create({
      data: {
        activity_id: rosterActivity.id,
        student_id: account.student.id,
        status: index < 23 ? 'accepted' : 'rejected',
        submitted_at: new Date(Date.now() - (25 - index) * 1000),
      },
    }));
  }
  const acceptedExpected = [];
  for (let page = 1; page <= 2; page++) {
    const pageData = result(await owner.request('/organizer/activities/' + rosterActivity.id +
      '/registrations?scope=managed&status=accepted&page_size=20&page=' + page), 200);
    acceptedExpected.push(...pageData.items);
  }
  assert.equal(acceptedExpected.length, 23);

  const receiptActivity = await ledgerActivity(db, ownerAccount.id, '回执导出活动');
  const receiptStudents = synthetic.slice(0, 4);
  await db.registration.createMany({
    data: [
      { activity_id: receiptActivity.id, student_id: receiptStudents[0].student.id, status: 'accepted' },
      { activity_id: receiptActivity.id, student_id: receiptStudents[1].student.id, status: 'accepted' },
      { activity_id: receiptActivity.id, student_id: receiptStudents[2].student.id, status: 'accepted' },
      { activity_id: receiptActivity.id, student_id: receiptStudents[3].student.id, status: 'withdrawn' },
    ],
  });
  const notice = await db.notice.create({
    data: {
      activity_id: receiptActivity.id,
      title: '集合信息导出测试',
      body: '请确认集合信息。',
      requires_ack: true,
      notice_kind: 'gathering',
      information_version: 1,
      is_current: true,
    },
  });
  await db.noticeReceipt.createMany({
    data: [
      { notice_id: notice.id, student_id: receiptStudents[0].student.id },
      { notice_id: notice.id, student_id: receiptStudents[1].student.id, read_at: new Date() },
      { notice_id: notice.id, student_id: receiptStudents[2].student.id, read_at: new Date(), acknowledged_at: new Date() },
      { notice_id: notice.id, student_id: receiptStudents[3].student.id },
    ],
  });

  const hoursActivity = await ledgerActivity(db, ownerAccount.id, '时长导出活动');
  const serviceDate = new Date(ledgerDay(3));
  await seedApprovedHours(db, {
    student_id: aliceStudent.id, activity_id: hoursActivity.id, service_date: serviceDate,
    hours: '2.0', version: 1, status: 'superseded', origin_schedule_revision: 1,
    misconduct_reported: 'none', misconduct_version: 0,
  }, ownerAccount.id);
  await seedApprovedHours(db, {
    student_id: aliceStudent.id, activity_id: hoursActivity.id, service_date: serviceDate,
    hours: '3.0', version: 2, status: 'current', origin_schedule_revision: 1,
    misconduct_reported: 'none', misconduct_version: 0,
  }, ownerAccount.id);

  let rosterExportId;
  await t.test('跨页名单按筛选导出、逐行核对并限制发起人', async () => {
    const job = await createExport(owner, { type: 'activity_roster', activity_id: rosterActivity.id, registration_status: 'accepted' });
    rosterExportId = job.id;
    const ready = await waitExport(owner, job.id);
    assert.equal(ready.status, 'ready');
    const file = await download(owner, job.id);
    assert.equal(file.status, 200);
    assert.match(decodeURIComponent(file.headers.get('content-disposition') ?? ''), /报名名单/);
    const rows = await rowsWithoutHeader(file.body, '报名名单');
    assert.deepEqual(rows.map((row) => row[1]), acceptedExpected.map((row) => row.student_no));
    assert.deepEqual(rows.map((row) => row[0]), acceptedExpected.map((row) => row.student_name));
    assert(rows.every((row) => row[3] === '已录取'));
    assert(rows.every((row) => /^0\d{9}$/.test(row[1])));
    const rosterCells = await sheetCells(file.body, '报名名单');
    assert.equal(rosterCells[1].find((cell) => cell.column === 1).type, 'text');

    const selected = acceptedExpected.slice(0, 2);
    const selectedJob = await createExport(owner, {
      type: 'activity_roster', activity_id: rosterActivity.id,
      registration_ids: selected.map((row) => row.id),
    });
    const selectedFile = await download(owner, (await waitExport(owner, selectedJob.id)).id);
    assert.deepEqual((await rowsWithoutHeader(selectedFile.body, '报名名单')).map((row) => row[1]),
      selected.map((row) => row.student_no));

    const filtered = await createExport(owner, { type: 'activity_roster', activity_id: rosterActivity.id, registration_status: 'accepted', q: '合成学生07' });
    const filteredFile = await download(owner, (await waitExport(owner, filtered.id)).id);
    const filteredRows = await rowsWithoutHeader(filteredFile.body, '报名名单');
    assert.equal(filteredRows.length, 1);
    assert.equal(filteredRows[0][0], '合成学生07');

    assert.equal((await other.request('/exports/' + job.id)).status, 404);
    assert.equal((await teacher.request('/exports/' + job.id)).status, 404);
    assert.equal((await other.request('/exports/' + job.id + '/download')).status, 404);
    assert.equal((await other.write('POST', '/exports',
      { type: 'activity_roster', activity_id: rosterActivity.id }, randomUUID())).status, 404);
  });

  await t.test('后台学生档案可按筛选批量导出，仅教职工可用', async () => {
    const profile = result(await alice.request('/me'), 200);
    assert.equal(Object.hasOwn(profile.student, 'cohort'), false);
    const currentJob = await createExport(teacher, { type: 'admin_students', student_ids: [aliceStudent.id] });
    const currentFile = await download(teacher, (await waitExport(teacher, currentJob.id)).id);
    const currentRows = await sheetRows(currentFile.body, '学生档案');
    assert.deepEqual(currentRows[0], ['学号', '姓名', '年级', '班级', '学院', '账号状态']);
    assert.equal(currentRows[1][0], aliceStudent.student_no);

    for (const [index, account] of synthetic.slice(0, 2).entries()) {
      await db.student.update({
        where: { id: account.student.id },
        data: {
          cohort: '本科生', grade: '2026', class_name: '0000009' + String(index).padStart(3, '0'),
          college: '信息与通信工程学院',
        },
      });
    }
    const expected = result(await teacher.request('/admin/students?cohort=' + encodeURIComponent('本科生') +
      '&grade=2026&q=' + encodeURIComponent('合成学生0') + '&page_size=100'), 200);
    assert.equal(expected.total, 2);
    const job = await createExport(teacher, {
      type: 'admin_students', cohort: '本科生', grade: '2026', q: '合成学生0',
    });
    const file = await download(teacher, (await waitExport(teacher, job.id)).id);
    const rows = await sheetRows(file.body, '学生档案');
    assert.deepEqual(rows[0], ['学号', '姓名', '级部', '年级', '班级', '学院', '账号状态']);
    assert.deepEqual(rows.slice(1).map((row) => row[0]), expected.items.map((row) => row.student_no));
    assert.equal(rows.length, 3);
    assert(rows.slice(1).every((row) => row[1].startsWith('合成学生0') && /^0\d{9}$/.test(row[0])));
    const selectedJob = await createExport(teacher, {
      type: 'admin_students', student_ids: expected.items.slice(0, 2).map((row) => row.id),
    });
    const selectedRows = await sheetRows((await download(teacher, (await waitExport(teacher, selectedJob.id)).id)).body, '学生档案');
    assert.deepEqual(selectedRows.slice(1).map((row) => row[0]), expected.items.slice(0, 2).map((row) => row.student_no));
    assert.equal((await teacher.write('POST', '/exports', {
      type: 'admin_students', student_ids: [randomUUID()],
    }, randomUUID())).status, 422);
    assert.equal((await alice.write('POST', '/exports', { type: 'admin_students' }, randomUUID())).status, 403);
  });

  await t.test('回执导出沿用 follow_up_only 并剔除已确认、已退出', async () => {
    const expected = result(await owner.request('/organizer/notices/' + notice.id +
      '/receipts?follow_up_only=true&page_size=100'), 200);
    assert.deepEqual(expected.items.map((row) => row.student_no),
      [receiptStudents[0].student.student_no, receiptStudents[1].student.student_no]);
    const job = await createExport(owner, { type: 'notice_receipts', notice_id: notice.id, follow_up_only: true });
    const ready = await waitExport(owner, job.id);
    assert.equal(ready.status, 'ready');
    const file = await download(owner, job.id);
    const rows = await sheetRows(file.body, '通知回执');
    assert.deepEqual(rows[0], ['通知：集合信息导出测试']);
    assert.deepEqual(rows[1], ['版本：第 1 版']);
    const data = rows.slice(3);
    assert.deepEqual(data.map((row) => row[0]), expected.items.map((row) => row.student_no));
    assert.deepEqual(data.map((row) => row[2]), ['未读', '已读未确认']);
    assert.equal(data.length, 2);
  });

  await t.test('三种时长范围含历史记录，合计只取 current', async () => {
    const activityExpected = result(await owner.request('/organizer/activities/' + hoursActivity.id +
      '/hours?include_history=true&page_size=100'), 200);
    assert.equal(activityExpected.items.length, 2);
    assert.equal(activityExpected.total_hours, '3.0');
    const activityJob = await createExport(owner,
      { type: 'activity_hours', activity_id: hoursActivity.id, include_history: true });
    const activityFile = await download(owner, (await waitExport(owner, activityJob.id)).id);
    const activityRows = await sheetRows(activityFile.body, '志愿时长');
    assert.deepEqual(activityRows[0], ['姓名', '学号', '活动名称', '活动编号', '服务日期', '时长（小时）', '记录状态']);
    assert.equal(activityRows.length, activityExpected.items.length + 2);
    assert.equal(activityRows.at(-1)[0], '合计（仅当前有效记录）');
    assert.equal(activityRows.at(-1)[5], '3');
    assert.deepEqual(activityRows.slice(1, -1).map((row) => Number(row[5])),
      activityExpected.items.map((row) => Number(row.credited_hours)));
    assert.deepEqual(activityRows.slice(1, -1).map((row) => row[6]),
      activityExpected.items.map((row) => row.status === 'current' ? '当前有效' : '已更正'));

    const myExpected = result(await alice.request('/me/hours?include_history=true&page_size=100'), 200);
    assert.equal(myExpected.total_hours, '3.0');
    const myJob = await createExport(alice, { type: 'my_hours', include_history: true });
    const myFile = await download(alice, (await waitExport(alice, myJob.id)).id);
    const myRows = await sheetRows(myFile.body, '志愿时长');
    assert.deepEqual(myRows[0], ['学生：体验学生（0000000001）']);
    assert.deepEqual(myRows[1], ['活动名称', '活动编号', '服务日期', '时长（小时）', '记录状态']);
    assert.equal(myRows.at(-1)[3], '3');
    assert.equal(myRows.at(-1)[0], '合计（仅当前有效记录）');
    assert.equal(myRows.length, 1 + 1 + myExpected.items.length + 1);

    const adminExpected = result(await teacher.request('/admin/students/' + aliceStudent.id +
      '/hours?include_history=true&page_size=100'), 200);
    assert.equal(adminExpected.total_hours, '3.0');
    const adminJob = await createExport(teacher,
      { type: 'admin_student_hours', student_id: aliceStudent.id, include_history: true });
    const adminFile = await download(teacher, (await waitExport(teacher, adminJob.id)).id);
    const adminRows = await sheetRows(adminFile.body, '志愿时长');
    assert.deepEqual(adminRows[0], ['学生：体验学生（0000000001）']);
    assert.equal(adminRows.at(-1)[3], '3');
  });

  await t.test('真实送审批准并更正的账目导出与三端读数一致', async () => {
    const realActivity = await ledgerActivity(db, ownerAccount.id, '真实更正导出活动');
    const day = ledgerDay(5);
    const student = await db.student.findUniqueOrThrow({
      where: { id: aliceStudent.id }, include: { account: true },
    });
    async function upload(mode, hours) {
      const form = new FormData();
      form.set('mode', mode);
      form.set('file', new Blob([await ledgerWorkbook(realActivity, [{ student, day, hours }])],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '真实时长.xlsx');
      const collection = '/organizer/activities/' + realActivity.id + '/hour-imports';
      const uploaded = await owner.raw(collection, {
        method: 'POST', body: form, headers: { 'Idempotency-Key': randomUUID() },
      });
      let body = await uploaded.json();
      assert.equal(uploaded.status, 202, JSON.stringify(body));
      const batch = await pollUntil(() => owner.request('/hour-imports/' + body.data.id).then(reply => result(reply, 200)),
        item => item.status !== 'validating', '时长校验');
      result(await owner.write('POST', '/hour-imports/' + batch.id + '/submit',
        { expected_version: batch.version, source_hash: batch.source_hash }), 200);
      const pending = result(await teacher.request('/hour-imports/' + batch.id), 200);
      result(await teacher.write('POST', '/admin/hour-imports/' + batch.id + '/decision',
        { expected_version: pending.version, decision: 'approved' }), 200);
    }
    await upload('new', '2.0');
    await upload('correction', '3.0');
    const query = '?from_date=' + day + '&to_date=' + day + '&include_history=true&page_size=100';
    const activityPage = result(await owner.request('/organizer/activities/' + realActivity.id + '/hours' + query), 200);
    const minePage = result(await alice.request('/me/hours' + query), 200);
    const adminPage = result(await teacher.request('/admin/students/' + aliceStudent.id + '/hours' + query), 200);
    for (const page of [activityPage, minePage, adminPage]) {
      assert.equal(page.total_hours, '3.0');
      assert.equal(page.items.length, 2);
      assert.deepEqual(new Set(page.items.map((row) => row.status)), new Set(['current', 'superseded']));
    }
    const job = await createExport(owner, {
      type: 'activity_hours', activity_id: realActivity.id,
      from_date: day, to_date: day, include_history: true,
    });
    const file = await download(owner, (await waitExport(owner, job.id)).id);
    const rows = await sheetRows(file.body, '志愿时长');
    assert.equal(rows.at(-1)[5], '3');
    assert.equal(rows.at(-1)[0], '合计（仅当前有效记录）');
    const cells = await sheetCells(file.body, '志愿时长');
    assert.equal(cells[1].find((cell) => cell.column === 1).type, 'text');
    assert.equal(cells[1].find((cell) => cell.column === 5).type, 'number');
    assert.equal(cells.at(-1).find((cell) => cell.column === 5).type, 'number');
    assert.equal(cells[1].find((cell) => cell.column === 0).type, 'text');
  });

  await t.test('活动时长可跨页选择学生导出汇总，每人一行且只计 current', async t => {
    const extra = synthetic[0];
    const record = await seedApprovedHours(db, {
      student_id: extra.student.id, activity_id: hoursActivity.id, service_date: new Date(ledgerDay(3)),
      hours: '1.5', version: 1, status: 'current', origin_schedule_revision: 1,
      misconduct_reported: 'none', misconduct_version: 0,
    }, ownerAccount.id);
    const selected = [aliceStudent.id, extra.student.id];
    const job = await createExport(owner, {
      type: 'activity_hours', activity_id: hoursActivity.id,
      from_date: ledgerDay(3), to_date: ledgerDay(3), student_ids: selected,
    });
    const ready = await waitExport(owner, job.id);
    assert.equal(ready.status, 'ready');
    const file = await download(owner, job.id);
    const rows = await sheetRows(file.body, '学生时长汇总');
    assert.deepEqual(rows[0], ['姓名', '学号', '合计时长（小时）']);
    assert.equal(rows.length, 3);
    const summaryCells = await sheetCells(file.body, '学生时长汇总');
    assert.equal(summaryCells[1].find((cell) => cell.column === 1).type, 'text');
    assert.equal(summaryCells[1].find((cell) => cell.column === 2).type, 'number');
    const byNo = new Map(rows.slice(1).map((row) => [row[1], row]));
    assert.deepEqual(byNo.get('0000000001').slice(0, 2), ['体验学生', '0000000001']);
    assert.equal(byNo.get('0000000001')[2], '3');
    assert.equal(byNo.get(extra.student.student_no)[2], '1.5');
    assert.equal(rows.slice(1).some((row) => row[1] === synthetic[1].student.student_no), false);

    const outside = await owner.write('POST', '/exports', {
      type: 'activity_hours', activity_id: hoursActivity.id, student_ids: [synthetic[1].student.id],
    }, randomUUID());
    assert.equal(outside.status, 422);
    // 所选两人都有时长记录，但其中一人的记录来源未获批准。
    const batch = { id: record.batch_id };
    await db.hourImportBatch.update({ where: batch, data: { status: 'rejected' } });
    t.after(() => db.hourImportBatch.update({ where: batch, data: { status: 'approved' } }));
    const unapproved = await owner.write('POST', '/exports', {
      type: 'activity_hours', activity_id: hoursActivity.id, student_ids: selected,
    }, randomUUID());
    assert.equal(unapproved.status, 422);
    const wrongType = await owner.write('POST', '/exports', {
      type: 'my_hours', student_ids: [aliceStudent.id],
    }, randomUUID());
    assert.equal(wrongType.status, 422);
  });

  await t.test('失权、换账号、过期均不能下载，学生不能取他人时长', async () => {
    assert.equal((await alice.write('POST', '/exports',
      { type: 'admin_student_hours', student_id: bobStudent.id }, randomUUID())).status, 403);
    const myJob = await createExport(alice, { type: 'my_hours' });
    await waitExport(alice, myJob.id);
    assert.equal((await bob.request('/exports/' + myJob.id)).status, 404);
    assert.equal((await bob.request('/exports/' + myJob.id + '/download')).status, 404);

    const job = await createExport(owner, { type: 'activity_hours', activity_id: hoursActivity.id });
    await waitExport(owner, job.id);
    await db.activityMember.delete({
      where: { activity_id_account_id: { activity_id: hoursActivity.id, account_id: ownerAccount.id } },
    });
    assert.equal((await owner.request('/exports/' + job.id)).status, 404);
    const denied = await owner.request('/exports/' + job.id + '/download');
    assert.equal(denied.status, 404);
    await db.activityMember.create({
      data: { activity_id: hoursActivity.id, account_id: ownerAccount.id, member_role: 'owner' },
    });

    const expiring = await createExport(owner, { type: 'activity_hours', activity_id: hoursActivity.id });
    await waitExport(owner, expiring.id);
    await db.exportJob.update({ where: { id: expiring.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    const expired = result(await owner.request('/exports/' + expiring.id), 200);
    assert.equal(expired.status, 'expired');
    const expiredDownload = await owner.request('/exports/' + expiring.id + '/download');
    assert.equal(expiredDownload.status, 409);

    for (const [resource, actor, code] of [
      [myJob.id, bobStudent.account_id, 'not_found'],
      [job.id, ownerAccount.id, 'not_found'],
      [expiring.id, ownerAccount.id, 'invalid_state'],
    ]) {
      const events = result(await teacher.request('/admin/audit-events?resource_id=' + resource +
        '&actor_id=' + actor), 200).items;
      const denied = events.filter((event) => event.action === 'download');
      assert.equal(denied.length, 1);
      assert.deepEqual(JSON.parse(denied[0].after), { result: 'denied', error: code });
    }
  });

  await t.test('数据库、Prisma 和审计筛选读取同一带偏移的毫秒时刻', async () => {
    const [{ clock, epoch, timezone }] = await db.$queryRaw`
      SELECT CURRENT_TIMESTAMP(3) AS clock, (extract(epoch FROM CURRENT_TIMESTAMP(3)) * 1000)::bigint AS epoch,
             current_setting('TimeZone') AS timezone`;
    assert.equal(timezone, 'UTC');
    assert.equal(clock.getTime(), Number(epoch));

    const offset = '2026-11-25T00:00:00.123+08:00';
    const at = new Date(offset), resource_id = randomUUID(), sqlId = randomUUID();
    await db.$executeRaw`
      INSERT INTO audit_event(id, actor_id, resource_type, resource_id, action, created_at)
      VALUES (${sqlId}::uuid, ${ownerAccount.id}::uuid, 'activity', ${resource_id}::uuid, 'sql_time', ${offset}::timestamptz)`;
    const fromSql = await db.auditEvent.findUniqueOrThrow({ where: { id: sqlId } });
    assert.equal(fromSql.created_at.toISOString(), at.toISOString());
    const fromPrisma = await db.auditEvent.create({ data: {
      actor_id: ownerAccount.id, resource_type: 'activity', resource_id, action: 'prisma_time', created_at: at,
    } });
    const [stored] = await db.$queryRaw`
      SELECT (extract(epoch FROM created_at) * 1000)::bigint AS epoch FROM audit_event WHERE id = ${fromPrisma.id}::uuid`;
    assert.equal(Number(stored.epoch), at.getTime());
    const endpoint = '/admin/audit-events?';
    const range = new URLSearchParams({ resource_id, from: offset, to: at.toISOString() });
    const exact = result(await teacher.request(endpoint + range), 200);
    assert.equal(exact.total, 2);
    assert.ok(exact.items.every(row => row.created_at === at.toISOString()));
    range.set('from', new Date(at.getTime() + 1).toISOString());
    range.delete('to');
    assert.equal(result(await teacher.request(endpoint + range), 200).total, 0);
  });

  await t.test('后台审计按操作者、对象和时间查询，展示脱敏前后值', async () => {
    const page = result(await teacher.request('/admin/audit-events?actor_id=' + ownerAccount.id +
      '&resource_id=' + rosterExportId + '&page_size=100'), 200);
    assert(page.items.some((row) => row.action === 'create'));
    assert(page.items.some((row) => row.action === 'download'));
    for (const row of page.items) {
      assert.equal(row.actor_id, ownerAccount.id);
      assert.equal(row.resource_id, rosterExportId);
      if (row.after) assert.equal(typeof row.after, 'string');
    }
    const from = new Date(Date.now() - 3600000).toISOString();
    const to = new Date(Date.now() + 3600000).toISOString();
    assert.equal(result(await admin.request('/admin/audit-events?from=' + from + '&to=' + to), 200).total >= 1, true);
    assert.equal((await alice.request('/admin/audit-events')).status, 403);
    assert.equal((await teacher.request('/admin/audit-events?actor_id=bad')).status, 422);
    assert.equal((await teacher.request('/admin/audit-events?from=bad')).status, 422);

    const resource = await db.exportJob.findUniqueOrThrow({ where: { id: rosterExportId } });
    await db.$transaction((tx) => audit(tx, {
      actor_id: ownerAccount.id, action: 'test_redact', resource_type: 'export', resource_id: resource.id,
      before: { password: 'plain', token: 'secret-token' }, after: { contents: Buffer.from('x').toString('base64'), normal: 'ok' },
    }));
    const redacted = result(await teacher.request('/admin/audit-events?resource_id=' + resource.id +
      '&page_size=100'), 200).items.find((row) => row.action === 'test_redact');
    assert.deepEqual(JSON.parse(redacted.before), { password: '[已脱敏]', token: '[已脱敏]' });
    assert.deepEqual(JSON.parse(redacted.after), { contents: '[已脱敏]', normal: 'ok' });
  });
}
