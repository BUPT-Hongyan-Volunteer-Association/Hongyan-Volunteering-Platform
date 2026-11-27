import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { changeNoticeBody } from '../dist/notices/notice.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { browser } from './api-client.mjs';

test('活动时间按北京时间显示，入群信息只在正文里提示更新', () => {
  const slot = (day) => ({
    starts_at: `2026-11-${day}T06:00:00Z`,
    ends_at: `2026-11-${day}T10:00:00Z`,
  });
  const version = (day, secret) => ({
    schedule: { schedule_type: 'custom', duration_start_date: '2026-11-' + day, duration_end_date: '2026-11-' + day, slots: [slot(day)] },
    registration_closes_at: slot(day).starts_at,
    group_join_instructions: secret,
  });
  const body = changeNoticeBody([version(25, '旧群号'), version(26, '新群号')]);
  assert.match(body, /活动时间：2026-11-25 → 2026-11-26/);
  assert.match(body, /报名截止时间：2026\/11\/25 14:00 → 2026\/11\/26 14:00/);
  assert.match(body, /入群方式：已更新/);
  assert.doesNotMatch(body, /旧群号|新群号/);
});

test('时长导入日期和联系方式依当前快照显示', () => {
  const message = changeNoticeBody([
    { contacts: ['13800000000'], hours_import_date: '2026-11-25' },
    { contacts: ['13800000000', '13900000000'], hours_import_date: '2026-11-26' },
  ]);
  assert.match(message, /2026-11-25 → 2026-11-26/);
  assert.match(message, /联系方式：13800000000 → 13800000000、13900000000/);
  assert.doesNotMatch(message, /21:30|05:30/);
});

test('站内通知、确认回执与事件队列', async (t) => {
  const staffPassword = randomUUID();
  let app;
  t.after(() => app?.close());
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword });
  t.mock.method(NoticeWorker.prototype, 'onModuleInit', () => {});
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    worker = app.get(NoticeWorker);
  const base = (await app.getUrl()) + '/api/v1';
  const [student, other, owner, ownerB, teacher] = Array.from({ length: 5 }, () => browser(base));
  await Promise.all([
    student.signIn('0000000001', '000001', 'T1' + randomUUID()),
    other.signIn('0000000004', '000004', 'T1' + randomUUID()),
    owner.signIn('0000000002', '000002', 'T1' + randomUUID()),
    ownerB.signIn('0000000003', '000003', 'T1' + randomUUID()),
    teacher.signIn('demo.teacher', staffPassword),
  ]);
  const sample = await db.activityRevision.findFirstOrThrow({
    where: { activity: { activity_code: 'P2026-0001' } },
  });
  const studentRow = (student_no) => db.student.findUniqueOrThrow({ where: { student_no } });

  async function publish(title, numbers = ['0000000001']) {
    const created = await owner.write('POST', '/organizer/activities', {
      ...sample.content,
      title,
      location: '甲',
      meeting_point: '一号门',
    });
    assert.equal(created.status, 201);
    const id = created.data.id,
      path = '/organizer/activities/' + id;
    const version = async () => (await owner.request(path)).data.activity.version;
    async function approve() {
      const review = await owner.write('POST', path + '/submit', {
        expected_version: await version(),
      });
      assert.equal(review.status, 201);
      const decision = await teacher.write(
        'POST',
        '/admin/activity-reviews/' + review.data.id + '/decision',
        {
          expected_version: review.data.version,
          decision: 'approved',
        },
      );
      assert.equal(decision.status, 200);
    }
    await approve();
    for (const student_no of numbers) {
      const { id: student_id } = await studentRow(student_no);
      await db.registration.create({ data: { activity_id: id, student_id, status: 'accepted' } });
    }
    return {
      id,
      async amend(fields) {
        const updated = await owner.write('PATCH', path, {
          ...fields,
          expected_version: await version(),
        });
        assert.equal(updated.status, 200);
        await approve();
      },
      event: (revision) =>
        db.notificationEvent.findFirstOrThrow({
          where: { activity_id: id, source_revision: revision },
        }),
      current: () =>
        db.notice.findFirstOrThrow({
          where: { activity_id: id, notice_kind: 'change', is_current: true },
        }),
    };
  }
  const inbox = async (client, query) => (await client.request('/me/notices?' + query)).data;
  const receipts = async (id, query = '') =>
    (await owner.request('/organizer/notices/' + id + '/receipts?' + query)).data;
  const eventById = (id) => db.notificationEvent.findUniqueOrThrow({ where: { id } });

  await t.test('普通通知按有效名单发布，幂等重试且独立保留', async () => {
    const a = await publish('手动通知范围');
    const path = '/organizer/activities/' + a.id + '/notices';
    const content = { title: '提醒', body: '请带证件', requires_ack: true, recipient_mode: 'accepted', notice_kind: 'other' };
    const key = randomUUID();
    const send = (fields, token) => owner.write('POST', path, { ...content, ...fields }, token);
    assert.equal((await ownerB.write('POST', path, content)).status, 404);
    assert.equal((await send({ notice_kind: 'gathering' })).status, 422);
    assert.equal((await send({ supersedes_id: randomUUID() })).status, 422);
    const [first, replay] = await Promise.all([send({}, key), send({}, key)]);
    assert.equal(first.status, 201);
    assert.equal(first.data.id, replay.data.id);
    assert.equal(first.data.recipient_count, 1);
    const second = await studentRow('0000000004');
    assert.equal((await send({ recipient_mode: 'selected', recipient_student_ids: [second.id] })).status, 422);
    await db.registration.create({ data: { activity_id: a.id, student_id: second.id, status: 'waitlisted' } });
    const all = await send({ recipient_mode: 'all_applicants', requires_ack: false });
    assert.equal(all.data.recipient_count, 2);
    assert.equal((await inbox(student, 'activity_id=' + a.id + '&unacknowledged_only=true')).items[0].id, first.data.id);
    await db.registration.updateMany({ where: { activity_id: a.id }, data: { status: 'withdrawn' } });
    assert.equal((await send({})).status, 422);
    assert.equal((await receipts(all.data.id)).total, 2);
  });

  await t.test('审批快照、重复投递、本人读写与活动管理范围', async () => {
    const a = await publish('通知范围');
    await a.amend({ location: '乙' });
    const before = await a.event(2);
    assert.equal(before.status, 'pending');
    await Promise.all([worker.drain(), new NoticeWorker(db).drain()]);
    assert.equal((await eventById(before.id)).attempt_count, 1);
    const notice = await a.current(),
      target = '/me/notices/' + notice.id;
    assert.equal(notice.information_version, 1);
    assert.match(notice.body, /活动地点：甲 → 乙/);
    assert.equal((await inbox(other, 'notice_id=' + notice.id)).total, 0);
    for (const action of ['read', 'ack'])
      assert.equal((await other.write('POST', target + '/' + action)).status, 404);
    assert.equal(
      (await ownerB.request('/organizer/notices/' + notice.id + '/receipts')).status,
      404,
    );
    assert.equal((await ownerB.request('/organizer/activities/' + a.id + '/notices')).status, 404);
    assert.equal((await student.request('/admin/notification-events')).status, 403);
    assert.equal((await receipts(notice.id, 'follow_up_only=true&status=acknowledged')).total, 0);
    const filters = 'activity_id=' + a.id + '&unread_only=true&with_counts=true&q=';
    const found = await inbox(student, filters + encodeURIComponent('活动地点'));
    assert.equal(found.total, 1);
    assert.deepEqual(found.inbox_counts, { all: 1, unread: 1, pending: 1, attention: 1 });
    assert.deepEqual((await inbox(other, filters)).inbox_counts, { all: 0, unread: 0, pending: 0, attention: 0 });
    assert.equal((await inbox(student, filters + '%25')).total, 0);
    const read = await student.write('POST', target + '/read');
    assert.ok(read.data.read_at);
    assert.equal(read.data.acknowledged_at, undefined);
    assert.equal((await receipts(notice.id, 'follow_up_only=true&status=read')).total, 1);
    const ack = await student.write('POST', target + '/ack');
    assert.equal(ack.data.read_at, read.data.read_at);
    assert.ok(ack.data.acknowledged_at);
    const afterAck = await inbox(student, filters);
    assert.equal(afterAck.total, 0);
    assert.deepEqual(afterAck.inbox_counts, { all: 1, unread: 0, pending: 0, attention: 0 });
    assert.equal(
      (await student.write('POST', target + '/ack')).data.acknowledged_at,
      ack.data.acknowledged_at,
    );
    await db.notificationEvent.update({ where: { id: before.id }, data: { status: 'pending' } });
    await worker.drain();
    assert.equal((await inbox(student, 'activity_id=' + a.id)).total, 1);
    assert.equal((await receipts(notice.id)).items[0].status, 'acknowledged');
    assert.equal(
      (await inbox(student, 'activity_id=' + a.id + '&unacknowledged_only=true')).total,
      0,
    );
  });

  await t.test('新修订合并未覆盖的字段，旧事件补发保留新回执，只改标题不会吞掉通知', async () => {
    const a = await publish('乱序与部分覆盖');
    await a.amend({ location: '乙', meeting_point: '二号门' });
    const old = await a.event(2);
    const later = new Date(Date.now() + 60_000);
    await db.notificationEvent.update({ where: { id: old.id }, data: { next_retry_at: later } });
    await a.amend({ location: '丙' });
    await a.amend({ title: '新标题' });
    await worker.drain();
    const current = await a.current();
    assert.match(current.body, /活动地点：甲 → 丙/);
    assert.match(current.body, /集合地点：一号门 → 二号门/);
    const ack = await student.write('POST', '/me/notices/' + current.id + '/ack');
    assert.equal(ack.data.read_at, ack.data.acknowledged_at);
    await worker.drain(later);
    assert.equal((await eventById(old.id)).status, 'superseded');
    assert.equal((await a.current()).id, current.id);
    assert.equal((await receipts(current.id)).items[0].acknowledged_at, ack.data.acknowledged_at);
  });

  await t.test('地点改回原值及连续两次变更入群方式都会产生新版本，历史名单不扩大', async () => {
    const a = await publish('恢复地点', ['0000000001', '0000000004']);
    await a.amend({ location: '乙' });
    await worker.drain();
    const first = await a.current();
    const { id: withdrawn } = await studentRow('0000000004');
    await db.registration.updateMany({
      where: { activity_id: a.id, student_id: withdrawn },
      data: { status: 'withdrawn' },
    });
    assert.equal(
      (await inbox(other, 'activity_id=' + a.id + '&unacknowledged_only=true')).total,
      0,
    );
    assert.equal((await receipts(first.id, 'follow_up_only=true')).total, 1);
    await a.amend({ location: '甲' });
    await worker.drain();
    const returned = await a.current();
    assert.equal(returned.supersedes_id, first.id);
    assert.match(returned.body, /活动地点：乙 → 甲/);
    assert.equal((await student.write('POST', '/me/notices/' + first.id + '/ack')).status, 409);
    assert.equal((await receipts(first.id)).total, 2);
    assert.equal((await receipts(first.id, 'follow_up_only=true')).total, 0);
    assert.equal((await receipts(returned.id)).total, 1);
    for (const value of ['第一次修改', '第二次修改']) {
      await a.amend({ group_join_instructions: value });
      await worker.drain();
    }
    const final = await a.current();
    assert.equal(final.information_version, 4);
    const historicalPage = await inbox(student, 'activity_id=' + a.id + '&page_size=1&page=2&with_counts=true');
    assert.equal(historicalPage.items.length, 1);
    assert.equal(historicalPage.total, 4);
    assert.deepEqual(historicalPage.inbox_counts, { all: 4, unread: 4, pending: 1, attention: 4 });
    assert.match(final.body, /入群方式：已更新/);
    assert.doesNotMatch(final.body, /第一次修改|第二次修改/);
    await db.registration.updateMany({
      where: { activity_id: a.id },
      data: { status: 'withdrawn' },
    });
    await a.amend({ location: '空名单地点' });
    await worker.drain();
    assert.equal((await a.event(6)).status, 'delivered');
    assert.equal(await db.notice.count({ where: { activity_id: a.id } }), 4);
    assert.equal(await db.notice.count({ where: { activity_id: a.id, is_current: true } }), 0);
  });

  await t.test('按 1/2/5/15/30 分钟重试，人工重试校验版本和原因并复用原事件', async () => {
    const a = await publish('退避');
    await a.amend({ location: '乙' });
    const { id } = await a.event(2);
    const failing = new NoticeWorker(db);
    failing.deliver = async () => {
      throw new Error('模拟投递失败');
    };
    let time = Date.now();
    for (const minutes of [1, 2, 5, 15, 30]) {
      await failing.drain(new Date(time));
      const event = await eventById(id);
      time += minutes * 60_000;
      assert.equal(event.next_retry_at.getTime(), time);
      await failing.drain(new Date(time - 1));
      assert.equal((await eventById(id)).attempt_count, event.attempt_count);
    }
    await failing.drain(new Date(time));
    const failed = await eventById(id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempt_count, 6);
    assert.match(failed.last_error, /按事件 ID 查阅服务日志/);
    assert.doesNotMatch(failed.last_error, /模拟投递失败/);
    const queue = await teacher.request('/admin/notification-events?status=failed');
    assert.ok(queue.data.items.some((row) => row.id === id));
    const retry = (body) =>
      teacher.write('POST', '/admin/notification-events/' + id + '/retry', body);
    assert.equal((await retry({ expected_version: failed.version })).status, 422);
    assert.equal(
      (await retry({ expected_version: failed.version - 1, reason: '复核' })).code,
      'version_conflict',
    );
    const result = await retry({ expected_version: failed.version, reason: '已复核' });
    assert.equal(result.status, 202);
    assert.equal(result.data.attempt_count, 0);
    await worker.drain();
    assert.equal((await eventById(id)).last_retry_reason, '已复核');
    assert.equal((await a.current()).source_event_id, id);
  });

  await t.test('不认识的申请种类和报名决定进入失败队列，不生成通知', async () => {
    const a = await publish('事件格式校验', []);
    const { id: student_id } = await studentRow('0000000001');
    for (const [event_type, detail] of [
      ['request_decided', { kind: 'unknown', status: 'approved' }],
      ['registration_decided', { status: 'unknown', registration_version: 2 }],
    ]) {
      const event = await db.notificationEvent.create({ data: {
        event_type, event_key: randomUUID(), activity_id: a.id, resource_id: randomUUID(), attempt_count: 5,
        payload: { student_id, ...detail },
      } });
      await worker.drain();
      const exact = await teacher.request('/admin/notification-events?id=' + event.id);
      assert.equal(exact.data.total, 1);
      assert.equal(exact.data.items[0].status, 'failed');
      assert.equal(await db.notice.count({ where: { source_event_id: event.id } }), 0);
    }
  });

  await t.test('租约过期后旧消费者的成功或失败都不会改写新消费者的投递', async () => {
    for (const fails of [true, false]) {
      const a = await publish('租约');
      await a.amend({ location: '乙' });
      const slow = new NoticeWorker(db);
      const deliver = slow.deliver.bind(slow);
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      slow.deliver = async (...args) => {
        entered.resolve();
        await release.promise;
        if (fails) throw new Error('旧消费者报错');
        return deliver(...args);
      };
      const now = new Date(),
        original = slow.drain(now);
      try {
        await Promise.race([
          entered.promise,
          original.then(() => {
            throw new Error('未认领事件');
          }),
        ]);
        await worker.drain(new Date(now.getTime() + 61_000));
      } finally {
        release.resolve();
        await original;
      }
      assert.equal((await a.event(2)).status, 'delivered');
      assert.equal((await a.event(2)).attempt_count, 2);
      assert.equal(await db.notice.count({ where: { activity_id: a.id } }), 1);
    }
  });

  await t.test('录取沿用决定事件 ID、报名 ID 与版本，重复交付保留一份结果', async () => {
    const a = await publish('录取回归', []);
    const applied = await student.write('POST', '/activities/' + a.id + '/registrations', {});
    assert.equal(applied.status, 201);
    const [registration] = applied.data.items;
    const decided = await owner.write(
      'POST',
      '/organizer/registrations/' + registration.id + '/decision?scope=managed',
      {
        expected_version: registration.version,
        decision: 'accepted',
        reason: '材料齐全',
      },
    );
    assert.equal(decided.status, 200);
    const event = await db.notificationEvent.findFirstOrThrow({
      where: { resource_id: registration.id, event_type: 'registration_decided' },
    });
    assert.equal(event.status, 'pending');
    assert.equal(event.payload.registration_version, decided.data.version);
    await worker.drain();
    await db.notificationEvent.update({ where: { id: event.id }, data: { status: 'pending' } });
    await worker.drain();
    const delivered = await eventById(event.id);
    assert.equal(delivered.resource_id, registration.id);
    assert.equal(delivered.status, 'delivered');
    const results = await inbox(student, 'notice_kind=result&activity_id=' + a.id);
    assert.equal(results.total, 1);
    assert.match(results.items[0].body, /已被录取.*[\s\S]*材料齐全/);
    assert.equal((await receipts(results.items[0].id)).total, 1);
  });
});
