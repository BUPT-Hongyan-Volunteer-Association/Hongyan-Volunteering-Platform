import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';

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
      assert.equal((await request('/me')).code, 'password_change_required');
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

test('活动发布、修订、越权与旧命令在真实 PostgreSQL 上保持一致', async (t) => {
  // Generate the database identifier here. Only this test-owned database is dropped.
  const name = 'hy_flow_' + randomUUID().replaceAll('-', '');
  const source = new URL(process.env.DATABASE_URL);
  const maintenance = new Database();
  await maintenance.$executeRawUnsafe('CREATE DATABASE ' + name);
  let app;
  try {
    source.pathname = '/' + name;
    process.env.DATABASE_URL = source.href;
    const staffPassword = randomUUID();
    prepareTestDatabase({ DEMO_STAFF_PASSWORD: staffPassword });
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const [student, owner, other, teacher] = Array.from({ length: 4 }, () => browser(base));
    await Promise.all([
      student.signIn('0000000001', '000001', 't1' + randomUUID()),
      owner.signIn('0000000002', '000002', 't1' + randomUUID()),
      other.signIn('0000000003', '000003', 't1' + randomUUID()),
      teacher.signIn('demo.teacher', staffPassword),
    ]);
    const sample = await db.activity.findUniqueOrThrow({
      where: { activity_code: 'P2026-0001' },
      include: { revisions: true },
    });
    const created = await owner.write('POST', '/organizer/activities', {
      ...sample.revisions[0].content,
      title: '回归测试',
      location: 'A',
    });
    assert.equal(created.status, 201);
    const id = created.data.id,
      path = '/organizer/activities/' + id;
    const managed = async () => (await owner.request(path)).data;
    const version = async () => (await managed()).activity.version;
    const publicDetail = () => student.request('/activities/' + id);
    const edit = async (fields) =>
      owner.write('PATCH', path, { ...fields, expected_version: await version() });
    const submit = async () => {
      const r = await owner.write('POST', path + '/submit', { expected_version: await version() });
      assert.equal(r.status, 201);
      return r.data;
    };
    const decide = (r, decision, reason, key) =>
      teacher.write(
        'POST',
        '/admin/activity-reviews/' + r.id + '/decision',
        { expected_version: r.version, decision, reason },
        key,
      );

    await t.test('首次驳回与首次发布', async () => {
      const first = await submit();
      assert.equal((await publicDetail()).status, 404);
      assert.equal((await decide(first, 'rejected', '请修订')).status, 200);
      assert.equal((await managed()).current_review.reason, '请修订');
      assert.equal((await publicDetail()).status, 404);
      assert.equal((await edit({ description: '已修订' })).status, 200);
      assert.equal((await decide(await submit(), 'approved')).status, 200);
      assert.equal((await publicDetail()).data.location, 'A');
    });
    const participant = await db.student.findUniqueOrThrow({ where: { student_no: '0000000004' } });
    await db.registration.create({
      data: { activity_id: id, student_id: participant.id, status: 'accepted' },
    });
    await t.test('待审、驳回和批准的公开可见性', async () => {
      const old = (await publicDetail()).data.schedule_revision;
      assert.equal((await edit({ location: 'B' })).status, 200);
      let r = await submit();
      assert(
        r.changes.some(
          (c) => c.field_path === 'location' && c.before_value === '"A"' && c.after_value === '"B"',
        ),
      );
      assert.equal((await publicDetail()).data.location, 'A');
      assert.equal((await decide(r, 'rejected', '待核实')).status, 200);
      assert.equal((await publicDetail()).data.schedule_revision, old);
      assert.equal((await edit({ location: 'B' })).status, 200);
      r = await submit();
      const key = randomUUID();
      const approved = await decide(r, 'approved', undefined, key);
      assert.equal(approved.status, 200);
      assert.deepEqual(await decide(r, 'approved', undefined, key), approved);
      const stale = await decide(r, 'approved');
      assert.equal(stale.status, 409);
      assert.equal(stale.code, 'version_conflict');
      const next = (await publicDetail()).data;
      assert.equal(next.location, 'B');
      assert.equal(next.schedule_revision, r.revision);
      assert(!Object.hasOwn(next, 'group_join_instructions'));
      assert.equal(await db.activityChangeEvent.count({ where: { review_id: r.id } }), 1);
      assert.equal(await db.reviewAudit.count({ where: { review_id: r.id } }), 1);
    });
    await t.test('按页读取审核快照、差异和活动版本', async () => {
      // Ties deliberately span pages. Keep the seed activity in the result set.
      await db.activityReview.updateMany({
        data: { created_at: new Date('2026-01-01T00:00:00Z') },
      });
      const expected = await db.activityReview.findMany({
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      });
      const queue = '/admin/activity-reviews';
      const seen = [];
      for (let page = 1; page <= Math.ceil(expected.length / 2) + 1; page++) {
        const result = await teacher.request(queue + '?page_size=2&page=' + page);
        assert.equal(result.status, 200);
        assert.equal(result.data.total, expected.length);
        assert.deepEqual(
          result.data.items.map((r) => r.id),
          expected.slice((page - 1) * 2, page * 2).map((r) => r.id),
        );
        for (const review of result.data.items) {
          assert.deepEqual(review, (await teacher.request(queue + '/' + review.id)).data);
          assert.equal(review.snapshot.activity_id, review.activity_id);
          seen.push(review);
        }
      }
      const approved = seen.find(
        (r) => r.activity_id === id && r.status === 'approved' && r.previous_published_snapshot,
      );
      assert.equal(approved.previous_published_snapshot.content.location, 'A');
      assert.equal(approved.snapshot.content.location, 'B');
      assert.deepEqual(approved.changes, [
        { field_path: 'location', before_value: '"A"', after_value: '"B"' },
      ]);
      const filtered = await teacher.request(queue + '?status=approved&page_size=1&page=2');
      assert.equal(filtered.data.total, 2);
      assert.equal(filtered.data.items[0].id, seen.filter((r) => r.status === 'approved')[1].id);
      assert.equal((await student.request(queue)).status, 403);
      assert.equal((await teacher.request(queue + '?page_size=101')).status, 422);

      const history = path + '/revisions';
      const all = (await owner.request(history)).data.items;
      assert.deepEqual(
        all.map((r) => r.revision),
        [4, 3, 2, 1],
      );
      for (const page of [1, 2, 3]) {
        const result = (await owner.request(history + '?page_size=3&page=' + page)).data;
        assert.equal(result.total, 4);
        assert.deepEqual(result.items, all.slice((page - 1) * 3, page * 3));
      }
      assert.deepEqual((await owner.request(history + '/4')).data, approved.snapshot);
      assert.deepEqual(
        (await owner.request(history + '/2')).data,
        approved.previous_published_snapshot,
      );
      assert.equal((await owner.request(history + '?page=0')).status, 422);
      for (const [actor, url, status, code] of [
        [owner, history + '/99', 404, 'not_found'],
        [owner, history + '/9007199254740991', 404, 'not_found'],
        [other, history, 404, 'not_found'],
        [other, history + '/1', 404, 'not_found'],
        [student, history + '/1', 403, 'forbidden'],
      ]) {
        const r = await actor.request(url);
        assert.equal(r.status, status);
        assert.equal(r.code, code);
      }
    });
    await t.test('录取者入群信息、自审拒绝和退出', async () => {
      const member = browser(base),
        dual = browser(base);
      await member.signIn('0000000004', '000004', 't1' + randomUUID());
      assert.equal(
        (await member.request('/activities/' + id)).data.group_join_instructions,
        '录取后向负责人领取群号',
      );
      assert.equal((await member.request('/auth/logout', { method: 'POST' })).status, 200);
      assert.equal((await member.request('/me')).status, 401);
      await dual.signIn('demo.dual', staffPassword);
      const item = (await dual.write('POST', '/organizer/activities', sample.revisions[0].content))
        .data;
      const submitted = (
        await dual.write('POST', '/organizer/activities/' + item.id + '/submit', {
          expected_version: item.version,
        })
      ).data;
      const denied = await dual.write(
        'POST',
        '/admin/activity-reviews/' + submitted.id + '/decision',
        { expected_version: submitted.version, decision: 'approved' },
      );
      assert.equal(denied.status, 403);
      assert.equal(denied.code, 'forbidden');
    });
    await t.test('跨活动操作与两个旧窗口', async () => {
      const original = await version();
      assert.equal((await other.request(path)).status, 404);
      assert.equal((await other.request(path + '/members')).status, 404);
      assert.equal(
        (await other.write('PATCH', path, { expected_version: original, title: '越权' })).status,
        404,
      );
      assert.equal(
        (await other.write('POST', path + '/submit', { expected_version: original })).status,
        404,
      );
      assert.equal(await version(), original);
      const saves = await Promise.all(
        ['窗口一', '窗口二'].map((title) =>
          owner.write('PATCH', path, { expected_version: original, title }),
        ),
      );
      assert.deepEqual(saves.map((s) => s.status).sort(), [200, 409]);
      assert.equal(saves.find((s) => s.status === 409).code, 'version_conflict');
    });
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await maintenance.$executeRawUnsafe('DROP DATABASE ' + name);
      } finally {
        await maintenance.$disconnect();
      }
    }
  }
});
