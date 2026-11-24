import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { canRecruit } from '../dist/registrations/registration.js';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { browser } from './api-client.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';

test('按日期与精确时段的退出、录取和恢复边界', () => {
  const dated = {
    schedule: {
      schedule_type: 'date_range',
      duration_start_date: '2026-11-24',
      duration_end_date: '2026-11-25',
    },
  };
  for (const [exit, boundary] of [
    [true, '2026-11-24'],
    [false, '2026-11-26'],
  ]) {
    const cutoff = Date.parse(boundary + 'T00:00:00+08:00');
    assert.ok(canRecruit(dated, exit, new Date(cutoff - 1)));
    assert.equal(canRecruit(dated, exit, new Date(cutoff)), false);
  }
  const start = '2026-11-25T13:00:00+08:00';
  const exact = {
    schedule: {
      schedule_type: 'custom',
      slots: [{ starts_at: start, ends_at: '2026-11-25T17:00:00+08:00' }],
    },
  };
  for (const exit of [false, true]) {
    assert.ok(canRecruit(exact, exit, new Date(Date.parse(start) - 1)));
    assert.equal(canRecruit(exact, exit, new Date(start)), false);
  }
});

test('招募写入、最后一席竞争及通知回执使用独立库', async (t) => {
  process.env.NOTICE_WORKER = 'off';
  let app;
  t.after(() => app?.close());
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: randomUUID() });
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    worker = app.get(NoticeWorker);
  const base = (await app.getUrl()) + '/api/v1';
  const users = Array.from({ length: 4 }, () => browser(base));
  const [alice, owner, bob, helper] = users;
  await Promise.all(
    users.map((u, i) =>
      u.signIn(String(i + 1).padStart(10, '0'), String(i + 1).padStart(6, '0'), randomUUID()),
    ),
  );
  const activity = await db.activity.findUniqueOrThrow({
    where: { activity_code: 'P2026-0001' },
    include: { revisions: true },
  });
  const id = activity.id,
    content = activity.revisions[0].content;
  const revision = { activity_id_revision: { activity_id: id, revision: 1 } };
  const registration = (r) => db.registration.findUniqueOrThrow({ where: { id: r.id } });
  const accepted = () => db.registration.count({ where: { activity_id: id, status: 'accepted' } });
  const success = (r, status = 200) => {
    assert.equal(r.status, status, JSON.stringify(r));
    return r.data;
  };
  const write = (u, path, body, key) => u.write('POST', path, body, key);
  const apply = (u) => write(u, '/activities/' + id + '/registrations', {});
  const items = (rows) => rows.map((r) => ({ registration_id: r.id, expected_version: r.version }));
  const bulk = (rows, decision, who = owner, key) =>
    write(
      who,
      '/organizer/activities/' + id + '/registration-decisions',
      { items: items(rows), decision },
      key,
    );
  const request = (u, kind, r) =>
    write(u, '/me/' + kind + '-requests', {
      registration_id: r.id,
      expected_registration_version: r.version,
      reason: '时间调整',
    });
  const finish = (u, kind, q, decision, key) =>
    write(
      u,
      '/organizer/' + kind + '-requests/' + q.id + '/decision',
      { expected_version: q.version, decision, reason: '已核实' },
      key,
    );
  const withdraw = (u, kind, q) =>
    write(u, '/me/' + kind + '-requests/' + q.id + '/withdraw', { expected_version: q.version });
  const counts = () =>
    Promise.all([
      db.registrationHistory.count(),
      db.registrationDecisionEvent.count(),
      db.notificationEvent.count(),
    ]);
  const mineSchedule = async () => {
    const { starts_at, ends_at } = content.schedule;
    const params = new URLSearchParams({ scope: 'mine', from: starts_at, to: ends_at });
    return success(await alice.request('/timeline?' + params)).items.some((a) => a.activity_id === id);
  };
  let a = success(await apply(alice), 201),
    b = success(await apply(bob), 201);
  const originalId = a.id;
  const helperStudent = await db.student.findUniqueOrThrow({ where: { student_no: '0000000004' } });
  const source = await db.notice.create({
    data: {
      activity_id: id,
      title: '集合',
      body: '南门',
      notice_kind: 'gathering',
      information_version: 3,
      receipts: { create: { student_id: helperStudent.id } },
    },
  });
  await t.test('本人撤回、窗口内原 ID 重提及关闭窗口后批量办理', async () => {
    const url = '/me/registrations/' + a.id + '/withdraw';
    assert.equal((await write(bob, url, { expected_version: a.version })).status, 404);
    assert.equal(success(await write(alice, url, { expected_version: a.version })).status, 'withdrawn');
    a = success(await apply(alice), 201);
    assert.equal(a.id, originalId);
    await db.activityRevision.update({
      where: revision,
      data: {
        content: {
          ...content,
          capacity: 2,
          registration_closes_at: new Date(Date.now() - 1000).toISOString(),
        },
      },
    });
    assert.equal((await apply(alice)).code, 'registration_closed');
    const before = await counts();
    assert.equal((await bulk([], 'accepted')).status, 422);
    assert.equal((await bulk([a, a], 'accepted')).status, 422);
    assert.equal((await bulk(Array(101).fill(a), 'accepted')).status, 422);
    const stale = await bulk([a, { ...b, version: b.version + 1 }], 'accepted');
    assert.equal(stale.details[0].resource_id, b.id);
    assert.equal((await bulk([a, b], 'accepted')).code, 'capacity_conflict');
    assert.deepEqual(await counts(), before);
    const key = randomUUID();
    const decision = await bulk([a, b], 'rejected', owner, key);
    assert.equal(success(decision).affected_count, 2);
    assert.deepEqual(await bulk([a, b], 'rejected', owner, key), decision);
    [a, b] = success(await bulk(await Promise.all([registration(a), registration(b)]), 'waitlisted')).items;
    a = success(await bulk([a], 'accepted')).items[0];
    assert.equal((await bulk([a], 'rejected')).code, 'invalid_state');
    await worker.drain();
    for (const [u, expected] of [
      [alice, '已被录取'],
      [bob, '进入候补'],
    ]) {
      const rows = success(await u.request('/me/notices?notice_kind=result')).items;
      assert.ok(rows.some((n) => n.body.includes(expected)));
      assert.ok(rows.some((n) => n.body.includes('未被录取')));
    }
  });
  await t.test('退出和恢复均可撤回、驳回，批准退出仅释放一次', async () => {
    let q = success(await request(alice, 'exit', a), 201);
    assert.equal(await accepted(), 2);
    assert.equal(await mineSchedule(), true);
    assert.equal((await request(alice, 'exit', a)).status, 409);
    assert.equal((await withdraw(bob, 'exit', q)).status, 404);
    success(await withdraw(alice, 'exit', q));
    assert.equal((await finish(owner, 'exit', q, 'approved')).status, 409);
    q = success(await request(alice, 'exit', a), 201);
    success(await finish(owner, 'exit', q, 'rejected'));
    assert.equal(await accepted(), 2);
    q = success(await request(alice, 'exit', a), 201);
    const key = randomUUID();
    const decision = await finish(owner, 'exit', q, 'approved', key);
    success(decision);
    assert.deepEqual(await finish(owner, 'exit', q, 'approved', key), decision);
    a = await registration(a);
    assert.equal(a.status, 'exited');
    assert.equal(await accepted(), 1);
    assert.equal(await mineSchedule(), false);
    q = success(await request(alice, 'restoration', a), 201);
    success(await withdraw(alice, 'restoration', q));
    q = success(await request(alice, 'restoration', a), 201);
    success(await finish(helper, 'restoration', q, 'rejected'));
    assert.equal((await registration(a)).status, 'exited');
  });
  await t.test('两负责人竞争最后一席，恢复仅跟进新的同版本回执', async () => {
    const q = success(await request(alice, 'restoration', a), 201);
    const [promotion, restoration] = await Promise.all([
      bulk([b], 'accepted'),
      finish(helper, 'restoration', q, 'approved'),
    ]);
    assert.deepEqual([promotion.status, restoration.status].sort(), [200, 409]);
    assert.equal(await accepted(), 2);
    if (promotion.status === 200) {
      assert.equal(restoration.code, 'capacity_conflict');
      assert.equal((await db.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'pending');
      const exit = success(await request(bob, 'exit', await registration(b)), 201);
      success(await finish(owner, 'exit', exit, 'approved'));
      success(await finish(helper, 'restoration', q, 'approved'));
    } else assert.equal(promotion.code, 'capacity_conflict');
    a = await registration(a);
    assert.equal(a.id, originalId);
    assert.equal(a.status, 'accepted');
    assert.equal(await mineSchedule(), true);
    await worker.drain();
    const inbox = (suffix) => alice.request('/me/notices?notice_kind=gathering' + suffix);
    const all = success(await inbox('')).items;
    assert.equal(all.length, 2);
    const current = success(await inbox('&unacknowledged_only=true')).items;
    assert.equal(current.length, 1);
    assert.ok(all.every((n) => n.source_notice_id === source.id && n.information_version === 3));
    assert.equal(await db.noticeReceipt.count({ where: { notice_id: source.id } }), 1);
    const event = await db.notice.findUniqueOrThrow({ where: { id: current[0].id } });
    await db.notificationEvent.update({ where: { id: event.source_event_id }, data: { status: 'pending' } });
    await worker.drain();
    assert.equal(success(await inbox('')).total, 2);
    assert.ok(
      success(await alice.request('/me/notices?notice_kind=result&page_size=100')).items.some((n) =>
        n.body.includes('恢复申请已批准'),
      ),
    );
  });
  await t.test('百人批量处理在停用一人时整批回滚，启用后只生效一次', async () => {
    const accounts = Array.from({ length: 100 }, (_, index) => ({
      id: randomUUID(),
      username: String(8100000000 + index),
      display_name: '独立库学生' + index,
      password_hash: 'fixture',
    }));
    await db.account.createMany({ data: accounts });
    const students = accounts.map((r) => ({ id: randomUUID(), student_no: r.username, account_id: r.id }));
    await db.student.createMany({ data: students });
    const records = students.map((r) => ({
      id: randomUUID(),
      version: 1,
      status: 'submitted',
      student_id: r.id,
      activity_id: id,
    }));
    await db.registration.createMany({ data: records });
    const last = accounts.at(-1);
    await db.account.update({ where: { id: last.id }, data: { active: false } });
    const before = await counts();
    const failure = await bulk(records, 'waitlisted');
    assert.equal(failure.status, 409);
    assert.equal(failure.details[0].resource_id, records.at(-1).id);
    assert.deepEqual(await counts(), before);
    await db.account.update({ where: { id: last.id }, data: { active: true } });
    const key = randomUUID();
    const result = await bulk(records, 'waitlisted', owner, key);
    assert.equal(success(result).affected_count, 100);
    assert.deepEqual(await bulk(records, 'waitlisted', owner, key), result);
    assert.deepEqual(
      await counts(),
      before.map((n, i) => n + (i === 0 ? 200 : 100)),
    );
    await worker.drain();
    await worker.drain();
  });
  await t.test('按日活动开始后可审批既有退出，当天可恢复，精确活动最后时段开始后禁止恢复', async () => {
    const q = success(await request(alice, 'exit', a), 201);
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const dateSchedule = {
      schedule_type: 'date_range',
      duration_start_date: today,
      duration_end_date: today,
    };
    const setSchedule = (schedule) =>
      db.activityRevision.update({ where: revision, data: { content: { ...content, schedule } } });
    await setSchedule(dateSchedule);
    success(await finish(owner, 'exit', q, 'approved'));
    a = await registration(a);
    const restoration = success(await request(alice, 'restoration', a), 201);
    await setSchedule({
      schedule_type: 'continuous',
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal((await finish(owner, 'restoration', restoration, 'approved')).code, 'invalid_state');
    await setSchedule(dateSchedule);
    success(await finish(owner, 'restoration', restoration, 'approved'));
    a = await registration(a);
    assert.equal((await request(alice, 'exit', a)).code, 'invalid_state');
    await setSchedule(content.schedule);
  });
  await t.test('活动终态在同一事务取消申请，成员被移出后旧窗口提交失败', async () => {
    const q = success(await request(alice, 'exit', a), 201);
    // 给另一名已退出学生预置待恢复申请，与退出申请一起验证同事务收尾。
    await db.registration.update({ where: { id: b.id }, data: { status: 'exited' } });
    const restore = success(await request(bob, 'restoration', await registration(b)), 201);
    success(await helper.request('/organizer/activities/' + id + '/exit-requests'));
    await db.activityMember.deleteMany({ where: { activity_id: id, account_id: helperStudent.account_id } });
    assert.equal((await finish(helper, 'exit', q, 'approved')).status, 404);
    for (const status of ['cancelled', 'completed']) {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.activity.update({ where: { id }, data: { status } });
          assert.equal((await tx.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'cancelled');
          assert.equal(
            (await tx.exitRequest.findUniqueOrThrow({ where: { id: restore.id } })).status,
            'cancelled',
          );
          throw new Error('rollback');
        }),
        /rollback/,
      );
      assert.equal((await db.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'pending');
    }
    await db.activity.update({ where: { id }, data: { status: 'completed' } });
    assert.equal((await finish(owner, 'exit', q, 'approved')).status, 409);
    await worker.drain();
    const results = success(await alice.request('/me/notices?notice_kind=result&page_size=100'));
    assert.ok(results.items.some((n) => n.body.includes('因活动取消或结束已取消')));
  });
});
