import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { browser } from './api-client.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';

test('现场异常批量登记、撤销、版本与活动权限', async (t) => {
  const password = 'T1' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: password });
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const [student, owner, outsider, helper, teacher] = Array.from({ length: 5 }, () => browser(base));
    await Promise.all([
      student.signIn('0000000001', '000001', password),
      owner.signIn('0000000002', '000002', password),
      outsider.signIn('0000000003', '000003', password),
      helper.signIn('0000000004', '000004', password),
      teacher.signIn('demo.teacher', password),
    ]);
    const db = app.get(Database);
    const approved = await db.activityRevision.findFirstOrThrow({ where: { activity: { activity_code: 'P2026-0001' } } });
    const activity_id = approved.activity_id;
    const day = '2026-11-09';
    const excluded = '2026-11-16';
    const following = '2026-11-23';
    const extraDay = '2026-11-18';
    const schedule = {
      schedule_type: 'weekly', duration_start_date: day, duration_end_date: following,
      weekly_slots: [
        { weekday: 1, start_time: '09:00:00', end_time: '10:00:00', end_day_offset: 0 },
        { weekday: 1, start_time: '14:00:00', end_time: '15:00:00', end_day_offset: 0 },
      ],
      excluded_dates: [excluded],
      additional_slots: [
        { starts_at: '2026-11-17T23:00:00+08:00', ends_at: `${extraDay}T01:00:00+08:00` },
        { starts_at: '2026-11-19T23:00:00+08:00', ends_at: '2026-11-20T00:00:00+08:00' },
      ],
    };
    await db.activityRevision.update({
      where: { activity_id_revision: { activity_id, revision: approved.revision } },
      data: { content: { ...approved.content, schedule } },
    });
    const getStudent = (student_no) => db.student.findUniqueOrThrow({ where: { student_no } });
    const [p1, spare, p2] = await Promise.all(['0000000001', '0000000002', '0000000004'].map(getStudent));
    await db.registration.createMany({ data: [p1, spare].map(({ id: student_id }) => ({
      activity_id, student_id, status: 'accepted',
    })) });
    const path = `/organizer/activities/${activity_id}/attendance`;
    const single = (person, serviceDate = day) => `${path}/${person.id}/${serviceDate}`;
    const find = async (serviceDate, query = '') => {
      const response = await owner.request(path + '?service_date=' + serviceDate + query);
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.data;
    };
    const roster = () => db.registration.findMany({ where: { activity_id }, orderBy: { id: 'asc' } });
    const originalRoster = await roster();
    const originalNotices = await db.notificationEvent.count();
    const batch = { service_date: day, status: 'late', reason: '第一时段晚到，第二时段准时', student_ids: [p1.id, p2.id] };

    assert.equal((await find(day)).total, 0);
    assert.equal((await owner.write('PUT', single(p1), { status: 'present', expected_version: 0 })).status, 422);
    assert.equal((await owner.write('POST', path, { ...batch, status: 'unrecorded' })).status, 422);
    assert.equal((await owner.write('POST', path, { ...batch, service_date: excluded })).status, 422);
    assert.equal((await owner.write('POST', path, { ...batch, service_date: '2026-11-20' })).status, 422);
    assert.equal((await owner.request(path + '?service_date=2026-11-31')).status, 422);
    assert.equal((await student.request(path)).status, 403);
    assert.equal((await outsider.request(path)).status, 404);
    assert.equal((await outsider.write('POST', path, batch)).status, 404);
    assert.equal((await owner.raw(path, { method: 'POST', headers: { 'X-CSRF-Token': '' } })).status, 403);

    const key = randomUUID();
    const [initial, replay] = await Promise.all([owner.write('POST', path, batch, key), owner.write('POST', path, batch, key)]);
    assert.equal(initial.status, 201, JSON.stringify(initial));
    assert.equal(initial.data.recorded_count, 2);
    assert.deepEqual(replay, initial);
    assert.equal((await owner.write('POST', path, { ...batch, status: 'absent' }, key)).status, 409);
    const firstPage = await find(day, '&page_size=1');
    const nextPage = await find(day, '&page_size=1&page=2');
    assert.equal(firstPage.total, 2);
    assert.equal(nextPage.total, 2);
    const rows = [...firstPage.items, ...nextPage.items];
    assert.deepEqual(new Set(rows.map((row) => row.student_id)), new Set(batch.student_ids));
    assert.ok(rows.every((row) => row.service_date === day && row.reason === batch.reason && row.status === 'late'));
    assert.equal((await find(following)).total, 0);
    const duplicate = await owner.write('POST', path, { ...batch, student_ids: [p1.id, spare.id] });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.code, 'attendance_already_recorded');
    assert.equal((await find(day)).total, 2);

    const stale = rows.find((row) => row.student_id === p1.id).version;
    assert.equal((await owner.write('PUT', single(p1), { expected_version: stale, status: 'other', reason: '  ' })).status, 422);
    const edits = await Promise.all([
      owner.write('PUT', single(p1), { expected_version: stale, status: 'other', reason: '临时换岗' }),
      helper.write('PUT', single(p1), { expected_version: stale, status: 'absent' }),
    ]);
    assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
    assert.equal(edits.find((r) => r.status === 409).code, 'version_conflict');
    const current = edits.find((r) => r.status === 200).data;
    const undoKey = randomUUID();
    const undo = { expected_version: current.version };
    const withdrawn = await helper.write('DELETE', single(p1), undo, undoKey);
    assert.equal(withdrawn.status, 200);
    assert.equal((await find(day)).total, 1);
    assert.deepEqual(await helper.write('DELETE', single(p1), undo, undoKey), withdrawn);
    assert.equal((await owner.write('POST', path, batch)).status, 409);
    assert.equal((await find(day)).total, 1);
    const reopened = await owner.write('POST', path, { ...batch, status: 'excused', student_ids: [p1.id] });
    assert.equal(reopened.status, 201);
    const restored = (await find(day)).items.find((row) => row.student_id === p1.id);
    assert.equal(restored.id, current.id);
    assert.equal(restored.version, withdrawn.data.version + 1);
    assert.equal(restored.status, 'excused');
    assert.equal((await owner.write('PUT', single(p1), { expected_version: current.version, status: 'late' })).status, 409);

    const unregistered_students = [{ student_no: '0000000003', student_name: '乙负责人' }];
    const manual = { service_date: extraDay, status: 'unregistered_participation', unregistered_students, reason: '现场临时替补' };
    assert.equal((await owner.write('POST', path, { ...manual, reason: '' })).status, 422);
    assert.equal((await owner.write('POST', path, { ...manual, unregistered_students: [
      ...unregistered_students, { student_no: '0000000004', student_name: '人员填写错误' },
    ] })).status, 422);
    assert.equal((await find(extraDay)).total, 0);
    assert.equal((await owner.write('POST', path, manual)).status, 201);
    const manualRow = (await find(extraDay)).items[0];
    assert.equal(manualRow.student_no, unregistered_students[0].student_no);
    assert.equal(manualRow.reason, manual.reason);
    assert.equal((await teacher.request(path)).data.total, 3);
    assert.equal((await teacher.write('PUT', single(p2), { expected_version: 1, status: 'excused' })).status, 200);
    await db.roleGrant.create({ data: { account_id: p2.account_id, role: 'reviewer' } });
    const managed = '?scope=managed';
    assert.equal((await helper.request(path + managed)).data.total, 3);
    await db.activityMember.delete({ where: { activity_id_account_id: { activity_id, account_id: p2.account_id } } });
    assert.equal((await helper.request(path)).status, 404);
    assert.equal((await helper.write('DELETE', single(p1), undo, undoKey)).status, 404);
    assert.equal((await helper.request(path + managed)).status, 404);
    assert.equal((await helper.write('POST', path + managed, batch)).status, 404);
    assert.equal((await helper.write('PUT', single(p1) + managed, { expected_version: restored.version, status: 'absent' })).status, 404);
    assert.equal((await helper.write('DELETE', single(p1) + managed, undo, undoKey)).status, 404);
    assert.equal((await owner.request(path + '?scope=all')).status, 403);
    assert.equal((await helper.request(path + '?scope=all')).data.total, 3);
    assert.equal((await helper.write('PUT', single(p1) + '?scope=all', { expected_version: restored.version, status: 'late' })).status, 200);
    assert.deepEqual(await roster(), originalRoster);
    assert.equal(await db.hourRecord.count(), 0);
    assert.equal(await db.notificationEvent.count(), originalNotices);
  } finally {
    await app.close();
  }
});
