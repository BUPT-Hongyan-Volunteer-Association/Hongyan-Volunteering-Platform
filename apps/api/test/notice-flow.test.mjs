import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { Clock } from '../dist/notices/clock.js';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';

function browser(base) {
  let cookie = '',
    csrf = '';
  async function request(path, { method = 'GET', body, key } = {}) {
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    const fresh = response.headers.get('set-cookie');
    if (fresh) cookie = fresh.split(';')[0];
    const payload = await response.json();
    if (path === '/auth/csrf' && response.ok) csrf = payload.data.csrf_token;
    return { status: response.status, ...payload };
  }
  async function signIn(username, password, newPassword) {
    await request('/auth/csrf');
    assert.equal(
      (await request('/auth/login', { method: 'POST', body: { username, password } })).status,
      200,
    );
    await request('/auth/csrf');
    if (newPassword) {
      assert.equal(
        (
          await request('/auth/change-password', {
            method: 'POST',
            body: { current_password: password, new_password: newPassword },
          })
        ).status,
        200,
      );
      await request('/auth/csrf');
    }
  }
  const write = (method, path, body, key = randomUUID()) => request(path, { method, body, key });
  return { request, signIn, write };
}

test('地点变更按事件投递站内通知，回执、催办与失败重试保持一致', async (t) => {
  const staffPassword = randomUUID();
  process.env.NOTICE_WORKER = 'off';
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword });
  let app;
  try {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const clock = app.get(Clock);
    const worker = app.get(NoticeWorker);
    const base = (await app.getUrl()) + '/api/v1';
    const [student, other, owner, ownerB, teacher] = Array.from({ length: 5 }, () =>
      browser(base),
    );
    await Promise.all([
      student.signIn('0000000001', '000001', 't1' + randomUUID()),
      other.signIn('0000000004', '000004', 't1' + randomUUID()),
      owner.signIn('0000000002', '000002', 't1' + randomUUID()),
      ownerB.signIn('0000000003', '000003', 't1' + randomUUID()),
      teacher.signIn('demo.teacher', staffPassword),
    ]);
    const sample = await db.activity.findUniqueOrThrow({
      where: { activity_code: 'P2026-0001' },
      include: { revisions: true },
    });
    const created = await owner.write('POST', '/organizer/activities', {
      ...sample.revisions[0].content,
      title: '通知回归',
      location: 'A',
    });
    assert.equal(created.status, 201);
    const id = created.data.id;
    const path = '/organizer/activities/' + id;
    const version = async () => (await owner.request(path)).data.activity.version;
    const submit = async () => {
      const r = await owner.write('POST', path + '/submit', { expected_version: await version() });
      assert.equal(r.status, 201);
      return r.data;
    };
    const decide = (r, decision = 'approved') =>
      teacher.write('POST', '/admin/activity-reviews/' + r.id + '/decision', {
        expected_version: r.version,
        decision,
      });
    const amend = async (fields) => {
      assert.equal(
        (await owner.write('PATCH', path, { ...fields, expected_version: await version() })).status,
        200,
      );
      const r = await submit();
      assert.equal((await decide(r)).status, 200);
    };
    const studentRow = async (student_no) =>
      db.student.findUniqueOrThrow({ where: { student_no } });
    const register = async (student_no, status = 'accepted') => {
      const s = await studentRow(student_no);
      await db.registration.create({ data: { activity_id: id, student_id: s.id, status } });
    };
    const drain = () => worker.drain(clock.now());

    assert.equal((await decide(await submit())).status, 200);
    await register('0000000001');
    await amend({ location: 'B' });

    await t.test('审批通过同一事务登记事件，消费后生成通知与接收人快照', async () => {
      const pending = await db.notificationEvent.findMany({ where: { activity_id: id } });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].status, 'pending');
      assert.equal(pending[0].attempt_count, 0);
      await drain();
      const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: pending[0].id } });
      assert.equal(event.status, 'delivered');
      assert.equal(event.attempt_count, 1);
      const notice = await db.notice.findFirstOrThrow({ where: { activity_id: id } });
      assert.equal(notice.title, '通知回归安排有调整');
      assert.match(notice.body, /活动地点/);
      assert.equal(notice.information_version, 1);
      assert.equal(notice.is_current, true);
      assert.equal(await db.noticeReceipt.count({ where: { notice_id: notice.id } }), 1);
      const mine = await student.request('/me/notices');
      assert.equal(mine.status, 200);
      assert.equal(mine.data.total, 1);
      assert.equal(mine.data.items[0].requires_ack, true);
      assert.equal(mine.data.items[0].read_at, undefined);
      assert.equal(mine.data.items[0].acknowledged_at, undefined);
    });

    await t.test('重复消费同一事件不重复生成通知', async () => {
      await drain();
      await drain();
      assert.equal(await db.notice.count({ where: { activity_id: id } }), 1);
      assert.equal(await db.activityChangeEvent.count({ where: { activity_id: id } }), 1);
    });

    await t.test('已读只标已读，确认幂等并保留首次确认时间', async () => {
      const notice = await db.notice.findFirstOrThrow({ where: { activity_id: id } });
      const read = await student.write('POST', `/me/notices/${notice.id}/read`);
      assert.equal(read.status, 200);
      assert.ok(read.data.read_at);
      assert.equal(read.data.acknowledged_at, undefined);
      assert.equal((await student.request('/me/notices?unacknowledged_only=true')).data.total, 1);
      const ack = await student.write('POST', `/me/notices/${notice.id}/ack`);
      assert.equal(ack.status, 200);
      assert.equal(ack.data.read_at, read.data.read_at);
      assert.ok(ack.data.acknowledged_at);
      const again = await student.write('POST', `/me/notices/${notice.id}/ack`);
      assert.equal(again.data.acknowledged_at, ack.data.acknowledged_at);
      assert.equal((await student.request('/me/notices?unacknowledged_only=true')).data.total, 0);
      const receipts = await owner.request(`/organizer/notices/${notice.id}/receipts`);
      assert.equal(receipts.status, 200);
      assert.equal(receipts.data.total, 1);
      assert.equal(receipts.data.items[0].status, 'acknowledged');
      assert.equal(receipts.data.items[0].student_no, '0000000001');
      assert.deepEqual(await owner.request(`/organizer/notices/${notice.id}/receipts?status=read`).then((r) => r.data.total), 0);
    });

    await t.test('越权读写他人通知与跨活动回执均不可见', async () => {
      const notice = await db.notice.findFirstOrThrow({ where: { activity_id: id } });
      assert.equal((await other.write('POST', `/me/notices/${notice.id}/read`)).status, 404);
      assert.equal((await ownerB.request(`/organizer/notices/${notice.id}/receipts`)).status, 404);
      assert.equal((await ownerB.request(`/organizer/activities/${id}/notices`)).status, 404);
      assert.equal((await student.request('/admin/notification-events')).status, 403);
    });

    await t.test('再次变更生成新版本并作废旧通知，催办名单排除已确认与已退出', async () => {
      await register('0000000004');
      await amend({ location: 'C' });
      await drain();
      const [first, second] = await db.notice.findMany({
        where: { activity_id: id },
        orderBy: { information_version: 'asc' },
      });
      assert.equal(second.information_version, 2);
      assert.equal(second.supersedes_id, first.id);
      assert.equal((await db.notice.findUniqueOrThrow({ where: { id: first.id } })).is_current, false);
      const history = await student.request('/me/notices');
      assert.equal(history.data.total, 2);
      await student.write('POST', `/me/notices/${second.id}/ack`);
      const follow = await owner.request(
        `/organizer/notices/${second.id}/receipts?follow_up_only=true`,
      );
      assert.equal(follow.data.total, 1);
      assert.equal(follow.data.items[0].student_no, '0000000004');
      await db.registration.updateMany({
        where: { activity_id: id, student_id: (await studentRow('0000000004')).id },
        data: { status: 'withdrawn' },
      });
      assert.equal(
        (await owner.request(`/organizer/notices/${second.id}/receipts?follow_up_only=true`)).data
          .total,
        0,
      );
      const full = await owner.request(`/organizer/notices/${second.id}/receipts`);
      assert.equal(full.data.total, 2);
      const superseded = await owner.request(
        `/organizer/notices/${first.id}/receipts?follow_up_only=true`,
      );
      assert.equal(superseded.data.total, 0);
    });

    await t.test('失败按 1/2/5/15/30 分钟退避重试，5 次后转人工，重试成功且不重复投递', async () => {
      const deliver = worker.deliver;
      worker.deliver = async () => {
        throw new Error('投递失败');
      };
      try {
        await amend({ location: 'D' });
        await drain();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          clock.advance(30 * 60 * 1000);
          await drain();
        }
        const event = await db.notificationEvent.findFirstOrThrow({
          where: { activity_id: id, source_revision: 4 },
        });
        assert.equal(event.status, 'failed');
        assert.equal(event.attempt_count, 6);
        assert.equal(event.last_error, '投递失败');
        const failed = await teacher.request('/admin/notification-events?status=failed');
        assert.equal(failed.status, 200);
        assert(failed.data.items.some((e) => e.id === event.id));
        const retry = await teacher.write('POST', `/admin/notification-events/${event.id}/retry`);
        assert.equal(retry.status, 202);
        assert.equal(retry.data.status, 'pending');
        assert.equal(retry.data.attempt_count, 0);
      } finally {
        worker.deliver = deliver;
      }
      await drain();
      const retried = await db.notificationEvent.findFirstOrThrow({
        where: { activity_id: id, source_revision: 4 },
      });
      assert.equal(retried.status, 'delivered');
      assert.equal(retried.attempt_count, 1);
      const notices = await db.notice.findMany({ where: { activity_id: id } });
      assert.equal(notices.length, 3);
      assert.equal(notices.filter((n) => n.is_current).length, 1);
    });

    await t.test('没有受影响学生时不生成空通知', async () => {
      const blank = await owner.write('POST', '/organizer/activities', {
        ...sample.revisions[0].content,
        title: '空名单活动',
        location: 'X',
      });
      assert.equal(blank.status, 201);
      const blankPath = '/organizer/activities/' + blank.data.id;
      const blankVersion = async () => (await owner.request(blankPath)).data.activity.version;
      const blankSubmit = async () => {
        const r = await owner.write('POST', blankPath + '/submit', {
          expected_version: await blankVersion(),
        });
        assert.equal(r.status, 201);
        return r.data;
      };
      assert.equal((await decide(await blankSubmit())).status, 200);
      assert.equal(
        (await owner.write('PATCH', blankPath, { location: 'Y', expected_version: await blankVersion() }))
          .status,
        200,
      );
      assert.equal((await decide(await blankSubmit())).status, 200);
      await drain();
      assert.equal(await db.notice.count({ where: { activity_id: blank.data.id } }), 0);
      const empty = await db.notificationEvent.findFirstOrThrow({
        where: { activity_id: blank.data.id },
      });
      assert.equal(empty.status, 'delivered');
    });

    await t.test('公开版本已被新修订替代的事件重试后标记 superseded 不发送', async () => {
      const deliver = worker.deliver;
      worker.deliver = async () => {
        throw new Error('投递失败');
      };
      try {
        await amend({ location: 'E' });
        await drain();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          clock.advance(30 * 60 * 1000);
          await drain();
        }
      } finally {
        worker.deliver = deliver;
      }
      const stale = await db.notificationEvent.findFirstOrThrow({
        where: { activity_id: id, source_revision: 5 },
      });
      assert.equal(stale.status, 'failed');
      await amend({ location: 'F' });
      await drain();
      const retry = await teacher.write('POST', `/admin/notification-events/${stale.id}/retry`);
      assert.equal(retry.status, 202);
      await drain();
      const after = await db.notificationEvent.findUniqueOrThrow({ where: { id: stale.id } });
      assert.equal(after.status, 'superseded');
      const notices = await db.notice.findMany({ where: { activity_id: id } });
      assert.equal(notices.length, 4);
      assert.equal(notices.filter((n) => n.is_current).length, 1);
      assert.equal((await db.notice.findFirstOrThrow({ where: { is_current: true } })).information_version, 4);
    });
  } finally {
    delete process.env.NOTICE_WORKER;
    await app?.close();
  }
});
