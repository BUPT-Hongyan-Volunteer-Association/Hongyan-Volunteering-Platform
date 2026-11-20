import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';
import { readFile } from 'node:fs/promises';
import { readHourUpload } from '../dist/hours/upload-input.js';
import { checkHourPreview, prepareHourPreviewFixture } from './hour-preview-fixture.mjs';
import { checkHourHttp } from './hour-http-fixture.mjs';

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
  const raw = (path, options = {}) => fetch(base + path, { ...options, headers: {
    Cookie:cookie, 'X-CSRF-Token':csrf, ...options.headers,
  } });
  return { request, signIn, write, raw };
}

test('活动发布、修订、越权与旧命令在真实 PostgreSQL 上保持一致', async (t) => {
  const staffPassword = randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword });
  let app;
  try {
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
    await t.test('时长上传先按当前活动授权，再解析文件', async () => {
      const template = await readFile(new URL('../../../packages/contracts/templates/志愿时长录入模板_v1.5.xlsx', import.meta.url));
      const upload = async (username, bytes) => {
        const account = await db.account.findUniqueOrThrow({ where: { username }, include: { roles: true } });
        return readHourUpload(db, { account_id: account.id, roles: account.roles.map((grant) => grant.role) },
          sample.id, '合成.xlsx', bytes);
      };
      assert.equal((await upload('0000000002', template)).template_structure, 'hours_misconduct_7');
      for (const [username, status] of [['0000000001', 403], ['0000000003', 404]]) {
        for (const file of [template, Buffer.alloc(0)]) {
          await assert.rejects(upload(username, file), (error) => error.getStatus() === status);
        }
      }
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
      const fallback = await managed();
      assert.equal(fallback.activity.schedule_revision, old);
      assert.equal(fallback.working_snapshot.revision, old);
      assert.equal(fallback.working_snapshot.content.location, 'A');
      assert.equal(fallback.current_review.snapshot.content.location, 'B');
      for (const scope of ['working', 'published']) {
        const list = '/organizer/activities?q=' + encodeURIComponent('回归测试') + '&revision_scope=' + scope;
        assert.equal((await owner.request(list + '&review_status=approved')).data.items[0].location, 'A');
        assert.equal((await owner.request(list + '&review_status=rejected')).data.total, 0);
      }
      const newDraft = await edit({ title: fallback.activity.title });
      assert.equal(newDraft.status, 200);
      assert.equal(newDraft.data.location, 'A');
      assert.equal(newDraft.data.schedule_revision, r.revision + 1);
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
      const mine = (await member.request('/activities?scope=mine')).data.items.find((a) => a.id === id);
      assert.equal(mine.my_registration_status, 'accepted');
      assert(!Object.hasOwn(mine, 'group_join_instructions'));
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
    await t.test('撤回已发布活动的修订后，详情回退且撤回快照保留', async () => {
      const before = await managed();
      await edit({ location: '待撤回地点' });
      const r = await submit();
      assert.equal((await managed()).activity.current_review_id, r.id);
      const response = await owner.write(
        'POST',
        '/organizer/activity-reviews/' + r.id + '/withdraw',
        {
          expected_version: r.version,
          reason: '撤回修订',
        },
      );
      assert.equal(response.status, 200);
      const after = await managed();
      assert.deepEqual(after.working_snapshot, before.published_snapshot);
      assert.equal(after.activity.has_pending_review, false);
      assert.equal(after.current_review.reason, '撤回修订');
      assert.equal(
        (await owner.request(path + '/revisions/' + r.revision)).data.revision_state,
        'withdrawn',
      );
    });

    await t.test('创建、送审和批准均校验完整时段的北京时间日期范围', async () => {
      const dates = { duration_start_date: '2027-05-01', duration_end_date: '2027-05-01' };
      const slot = { starts_at: '2027-05-01T15:00:00Z', ends_at: '2027-05-01T16:00:00Z' };
      const rule = { weekday: 6, start_time: '23:00', end_time: '00:00', end_day_offset: 1 };
      const custom = { schedule_type: 'custom', ...dates, slots: [slot] };
      const weekly = { schedule_type: 'weekly', ...dates, weekly_slots: [rule] };
      const input = {
        ...sample.revisions[0].content,
        registration_opens_at: '2027-04-01T08:00:00Z',
        registration_closes_at: '2027-04-20T08:00:00Z',
      };
      const outside = { ...slot, ends_at: '2027-05-01T16:01:00Z' };
      const bad = { ...custom, slots: [outside] };
      function check(response, field) {
        assert.equal(response.status, 422);
        assert.equal(response.details[0].field, field);
      }
      const create = (schedule) =>
        owner.write('POST', '/organizer/activities', { ...input, schedule });
      for (const [schedule, field] of [
        [bad, 'schedule.slots.0'],
        [
          { ...custom, slots: [{ ...slot, starts_at: '2027-04-30T15:59:00Z' }] },
          'schedule.slots.0',
        ],
        [{ ...weekly, weekly_slots: [{ ...rule, end_time: '01:00' }] }, 'schedule.weekly_slots.0'],
        [{ ...weekly, additional_slots: [outside] }, 'schedule.additional_slots.0'],
        [{ ...custom, duration_end_date: '2027-04-30' }, 'schedule.duration_end_date'],
      ])
        check(await create(schedule), field);
      assert.equal((await create(weekly)).status, 201);
      const created = await create(custom);
      assert.equal(created.status, 201);
      const draft = created.data;
      const base = '/organizer/activities/' + draft.id;
      check(
        await owner.write('PATCH', base, { schedule: bad, expected_version: draft.version }),
        'schedule.slots.0',
      );
      const where = { activity_id_revision: { activity_id: draft.id, revision: 1 } };
      // A previously saved snapshot is checked again at each publication boundary.
      const persisted = (schedule) =>
        db.activityRevision.update({ where, data: { content: { ...input, schedule } } });
      const send = () => owner.write('POST', base + '/submit', { expected_version: draft.version });
      await persisted(bad);
      check(await send(), 'schedule.slots.0');
      await persisted(custom);
      const review = await send();
      assert.equal(review.status, 201);
      await persisted(bad);
      check(await decide(review.data, 'approved'), 'schedule.slots.0');
      assert.equal((await owner.request(base)).data.current_review.status, 'pending');
      assert.equal((await student.request('/activities/' + draft.id)).status, 404);
    });
    await t.test('活动列表跨批筛选后仍返回准确总数和稳定页序', async () => {
      const original = sample.revisions[0],
        count = 104;
      const activities = Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        activity_code: 'LIST-' + String(index).padStart(3, '0'),
        status: 'published',
        working_revision: 1,
        published_revision: 1,
      }));
      await db.activity.createMany({ data: activities });
      await db.activityMember.createMany({
        data: activities.map((a) => ({
          activity_id: a.id,
          account_id: original.created_by,
          member_role: 'owner',
        })),
      });
      await db.activityRevision.createMany({
        data: activities.map((a, i) => ({
          activity_id: a.id,
          revision: 1,
          revision_state: 'approved',
          created_by: original.created_by,
          content: { ...original.content, campus: i % 2 ? '东区' : '西区' },
        })),
      });
      for (const [actor, endpoint] of [
        [student, '/activities'],
        [owner, '/organizer/activities'],
      ]) {
        const search =
          '?q=LIST-&campus=' +
          encodeURIComponent('东区') +
          '&registration_phase=open&page_size=2&page=';
        const last = (await actor.request(endpoint + search + '26')).data;
        assert.equal(last.total, 52);
        assert.deepEqual(
          last.items.map((a) => a.activity_code),
          ['LIST-101', 'LIST-103'],
        );
        assert.deepEqual((await actor.request(endpoint + search + '27')).data.items, []);
      }
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

    await t.test('两名学生竞争最后一席时只写入一次录取和决定事件', async () => {
      // One participant is already accepted.
      assert.equal((await edit({ capacity: 2 })).status, 200);
      assert.equal((await decide(await submit(), 'approved')).status, 200);
      const applications = await Promise.all([student, other].map((actor) =>
        actor.write('POST', '/activities/' + id + '/registrations', {}),
      ));
      const commands = applications.map((r) => {
        assert.equal(r.status, 201);
        const key = randomUUID();
        return () => owner.write('POST', '/organizer/registrations/' + r.data.id + '/decision?scope=managed',
          { expected_version: r.data.version, decision: 'accepted' }, key);
      });
      const decisions = await Promise.all(commands.map((run) => run()));
      assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
      assert.equal(decisions.find((r) => r.status === 409).code, 'capacity_conflict');
      const winner = decisions.findIndex((r) => r.status === 200);
      assert.deepEqual(await commands[winner](), decisions[winner]);
      assert.equal(await db.registration.count({ where: { activity_id: id, status: 'accepted' } }), 2);
      assert.equal(await db.registrationDecisionEvent.count({ where: { activity_id: id } }), 1);
    });

    const fixture = await prepareHourPreviewFixture(db, sample);
    await t.test('混合工作簿重复预览保持逐行结果和正式时长一致', () => checkHourPreview(db, fixture));
    await t.test('独立库混合工作簿：HTTP 上传、报告、权限回收和失败重试均不入账', () =>
      checkHourHttp(db, fixture, { owner, other, student, teacher }));
  } finally {
    await app?.close();
  }
});
