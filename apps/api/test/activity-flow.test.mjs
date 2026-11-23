import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';
import { checkHourPreview, prepareHourPreviewFixture } from './hour-preview-fixture.mjs';
import { checkHourHttp } from './hour-http-fixture.mjs';

import { browser } from './api-client.mjs';

test('活动发布、修订、越权与旧命令在真实 PostgreSQL 上保持一致', async (t) => {
  const staffPassword = randomUUID();
  const adminPassword = randomUUID();
  const ownerPassword = 't1' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword, DEMO_ADMIN_PASSWORD: adminPassword });
  let app;
  try {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const [student, owner, other, teacher] = Array.from({ length: 4 }, () => browser(base));
    await Promise.all([
      student.signIn('0000000001', '000001', 't1' + randomUUID()),
      owner.signIn('0000000002', '000002', ownerPassword),
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
      const approvedActivity = (await managed()).activity;
      const old = approvedActivity.schedule_revision;
      const unchanged = await edit({});
      assert.equal(unchanged.status, 200);
      assert.equal(unchanged.data.version, approvedActivity.version);
      assert.equal(unchanged.data.schedule_revision, old);
      assert.equal(unchanged.data.revision_state, 'approved');
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
      assert.deepEqual((await dual.request('/activities?scope=mine&page=2')).data,
        { items: [], total: 0, page: 2, page_size: 20 });
      const publicView = (await dual.request('/activities/' + id)).data;
      assert.equal(publicView.id, id);
      assert(!Object.hasOwn(publicView, 'group_join_instructions'));
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

    await t.test('按日活动从标题草稿到录取：报名分钟边界、校区筛选和版本图片权限', async (t) => {
      const create = await owner.write('POST', '/organizer/activities', {
        title: '双校区书籍整理',
      });
      assert.equal(create.status, 201);
      const base = '/organizer/activities/' + create.data.id,
        publicPath = '/activities/' + create.data.id;
      assert.equal(create.data.starts_at, undefined);
      const version = async () => (await owner.request(base)).data.activity.version;
      const save = async (fields) =>
        owner.write('PATCH', base, { ...fields, expected_version: await version() });
      const send = async () =>
        owner.write('POST', base + '/submit', { expected_version: await version() });
      const missing = await send();
      assert.equal(missing.status, 422);
      for (const key of [
        'description',
        'transport_notes',
        'duration_start_date',
        'duration_end_date',
        'contacts',
        'result_expected_date',
        'group_join_instructions',
        'hours_import_date',
      ])
        assert.ok(
          missing.details.some((d) => d.field === key),
          key,
        );
      const invalidContacts = await save({ contacts: ['13800000000','  '] });
      assert.equal(invalidContacts.status, 422);
      assert.ok(invalidContacts.details.some(d => d.field === 'contacts.1'));
      assert.equal((await save({result_expected_date:'2027-01-01T09:30:00+08:00'})).status,422);
      assert.equal((await save({contacts:[], result_expected_date:'2025-05-01'})).status,200);
      assert.ok((await send()).details.some(d => d.field === 'contacts'));
      const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kSAAAAAASUVORK5CYII=';
      assert.equal((await save({ group_qr_upload: 'data:image/png;base64,eA==' })).status, 422);
      const tooLarge =
        'data:image/jpeg;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
      assert.equal((await save({ group_qr_upload: tooLarge })).status, 422);
      const at = (time) => '2025-05-01T' + time + '+08:00';
      const saved = await save({
        campus: '两个校区',
        location: '图书馆',
        description: '整理书籍',
        beneficiaries: '师生',
        meeting_point: '服务台',
        transport_notes: '步行到馆',
        capacity: 10,
        contacts: ['13800000000', '志协办公室 A205', '13900000000'],
        schedule: {
          schedule_type: 'date_range',
          duration_start_date: '2025-05-01',
          duration_end_date: '2025-05-01',
        },
        registration_opens_at: at('09:00:00'),
        registration_closes_at: at('09:30:00'),
        result_expected_date: '2025-05-01',
        group_qr_upload: png,
        hours_rule_text: '以实到记录为准',
        hours_import_date: '2025-05-05',
      });
      assert.equal(saved.status, 200);
      const image = '/activity-group-images/' + saved.data.group_qr_id;
      const review = await send();
      assert.equal(review.status, 201);
      assert.equal((await teacher.raw(image)).headers.get('content-type'), 'image/png');
      assert.equal((await other.raw(image)).status, 404);
      assert.equal((await decide(review.data, 'approved')).status, 200);
      for (const campus of ['沙河', '西土城校区', '海淀校区']) {
        const items = (
          await student.request(
            '/activities?q=' +
              encodeURIComponent('双校区书籍整理') +
              '&campus=' +
              encodeURIComponent(campus),
          )
        ).data.items;
        assert.equal(items.length, 1);
        assert.equal(items[0].group_qr_id, undefined);
        assert.deepEqual(items[0].contacts, ['13800000000', '志协办公室 A205', '13900000000']);
        assert.equal(items[0].result_expected_date, '2025-05-01');
        assert.equal(items[0].result_expected_at, undefined);
      }
      assert.equal((await student.request(publicPath)).data.group_qr_id, undefined);
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at('09:29:59')) });
      const apply = (actor) => actor.write('POST', publicPath + '/registrations', {});
      const a = await apply(student),
        b = await apply(other);
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      t.mock.timers.setTime(Date.parse(at('09:30:00')));
      assert.equal((await apply(student)).code, 'registration_closed');
      const admit = (application) =>
        owner.write('POST', '/organizer/registrations/' + application.data.id + '/decision', {
          expected_version: application.data.version,
          decision: 'accepted',
        });
      t.mock.timers.setTime(Date.parse(at('23:59:59')));
      assert.equal((await admit(a)).status, 200);
      assert.equal((await student.raw(image)).status, 200);
      t.mock.timers.tick(1000);
      assert.equal((await admit(b)).status, 409);
      const replacement = await save({
        group_qr_upload: png,
        group_join_instructions: '书籍整理群',
        eligibility_text: '自带手套',
        safety_notes: '活动前培训',
      });
      const nextImage = '/activity-group-images/' + replacement.data.group_qr_id;
      assert.notEqual(nextImage, image);
      const next = await send();
      assert.equal((await student.raw(nextImage)).status, 404);
      assert.equal((await student.raw(image)).status, 200);
      assert.equal((await decide(next.data, 'approved')).status, 200);
      assert.equal((await student.raw(nextImage)).status, 200);
      assert.equal((await student.raw(image)).status, 404);
      assert.equal((await teacher.raw(image)).status, 200);
      const cleared = await save({ group_qr_id: null, eligibility_text: null, safety_notes: null });
      assert.equal(cleared.status, 200);
      for (const key of ['group_qr_id', 'eligibility_text', 'safety_notes'])
        assert.equal(cleared.data[key], undefined);
      assert.equal((await send()).status, 201);
    });

    const fixture = await prepareHourPreviewFixture(db, sample);
    await t.test('混合工作簿重复预览保持逐行结果和正式时长一致', () => checkHourPreview(db, fixture));
    await t.test('独立库混合工作簿：HTTP 上传、报告、权限回收和失败重试均不入账', () =>
      checkHourHttp(db, fixture, { owner, other, student, teacher }));
    await t.test('精确查找有效负责人并加入本活动，重复请求只写一次', async () => {
      const team = '/organizer/activities/' + sample.id + '/members';
      const find = (actor, number) => actor.request(team.replace('/members', '/member-candidates?student_no=') + number);
      const number = '0000000003';
      const account_id = (await other.request('/me')).data.account_id;
      const expected_version = (await owner.request(team)).data.version;
      const body = { account_id, expected_version, reason:'协助现场签到' };
      assert.equal((await find(owner, '003')).status, 422);
      assert.deepEqual((await find(owner, number)).data.items, [{ account_id, student_no:number, display_name:'乙负责人' }]);
      assert.deepEqual((await find(owner, '0000000001')).data.items, []);
      assert.equal((await find(teacher, number)).status, 200);
      assert.equal((await find(other, number)).status, 404);
      assert.equal((await other.request(team)).status, 404);
      const grant = {account_id_role:{account_id, role:'organizer'}};
      await db.roleGrant.update({where:grant,data:{expires_at:new Date(0)}});
      assert.deepEqual((await find(owner, number)).data.items, []);
      assert.equal((await owner.write('POST',team,body)).status, 422);
      await db.roleGrant.update({where:grant,data:{expires_at:null}});
      const key = randomUUID();
      const attempts = await Promise.all([owner.write('POST', team, body, key), owner.write('POST', team, body, key)]);
      assert.deepEqual(attempts[0], attempts[1]);
      assert.equal(attempts[0].status, 200);
      const added = attempts[0].data;
      assert.equal(added.version, expected_version + 1);
      assert.deepEqual(added.items.filter(member => member.account_id === account_id).map(member => member.member_role), ['collaborator']);
      assert.equal((await owner.write('POST',team,body)).code, 'version_conflict');
      assert.deepEqual((await owner.write('POST',team,{...body,expected_version:added.version})).data, added);
      assert.equal((await other.request(team.replace('/members','/registrations'))).status, 200);
      assert.equal((await other.request(path + '/registrations')).status, 404);
      assert.equal((await find(other, number)).status, 404);
      assert.equal((await other.write('POST',team,body)).status, 404);
      const events = await db.auditEvent.findMany({where:{resource_id:sample.id, action:'add_activity_member'}});
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, body.reason);
      assert.equal(events[0].actor_id, (await owner.request('/me')).data.account_id);
      assert.equal(events[0].before.members.length + 1, events[0].after.members.length);
      assert.deepEqual(Object.keys(events[0].after.members[0]).sort(), ['account_id','member_role']);
    });
    await t.test('交接复核资格、版本，并发只产生一次换任', async () => {
      const base = '/organizer/activities/' + sample.id;
      const members = () => owner.request(base + '/members');
      const before = (await members()).data;
      const target = (await other.request('/me')).data.account_id;
      const oldOwner = (await owner.request('/me')).data.account_id;
      const body = { expected_version: before.version, target_account_id: target, reason: '现场交接' };
      const post = (user, data) => user.write('POST', base + '/transfer-owner', data);
      assert.equal((await post(other, body)).status, 404);
      assert.equal((await post(owner, { ...body, target_account_id: oldOwner })).status, 422);
      assert.equal((await post(owner, { ...body, expected_version: before.version - 1 })).status, 409);
      const where = { account_id_role: { account_id: target, role: 'organizer' } };
      await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
      assert.equal((await post(owner, body)).status, 422);
      await db.roleGrant.update({ where, data: { expires_at: null } });
      const attempts = await Promise.all([post(owner, body), post(owner, body)]);
      assert.deepEqual(attempts.map(r => r.status).sort(), [200, 404]);
      const after = (await members()).data;
      assert.equal(after.version, before.version + 1);
      assert.deepEqual(after.items.filter(m => m.member_role === 'owner').map(m => m.account_id), [target]);
      assert.equal(after.items.find(m => m.account_id === oldOwner).member_role, 'collaborator');
      assert.equal(await db.auditEvent.count({ where: { resource_id: sample.id, action: 'transfer_activity_owner', actor_id: oldOwner, reason: body.reason } }), 1);
    });
    await t.test('移除协作者只撤销该活动访问权，重放只记一次审计', async () => {
      const base = '/organizer/activities/' + sample.id;
      const team = base + '/members';
      const before = (await other.request(team)).data;
      const formerOwner = (await owner.request('/me')).data;
      const currentOwner = (await other.request('/me')).data.account_id;
      const endpoint = team + '/' + formerOwner.account_id;
      const body = { expected_version: before.version, reason: '现场工作已交接' };
      for (const route of ['/registrations', '/attendance'])
        assert.equal((await owner.request(base + route)).status, 200);
      assert.equal((await owner.write('DELETE', endpoint, body)).status, 404);
      assert.equal((await other.write('DELETE', team + '/' + currentOwner, body)).status, 422);
      assert.equal((await other.write('DELETE', endpoint, { ...body, reason: '  ' })).status, 422);
      assert.equal((await other.write('DELETE', endpoint, { ...body, expected_version: before.version - 1 })).code, 'version_conflict');
      const key = randomUUID();
      const removed = await other.write('DELETE', endpoint, body, key);
      assert.equal(removed.status, 200);
      assert.deepEqual(await other.write('DELETE', endpoint, body, key), removed);
      assert.equal(removed.data.version, before.version + 1);
      assert.deepEqual(removed.data.items, before.items.filter(m => m.account_id !== formerOwner.account_id));
      for (const route of ['/registrations', '/attendance'])
        assert.equal((await owner.request(base + route)).status, 404);
      assert.equal((await owner.request('/me/hours')).status, 200);
      assert.equal((await owner.request(path + '/members')).status, 200);
      assert.deepEqual((await owner.request('/me')).data.roles, formerOwner.roles);
      const events = await db.auditEvent.findMany({ where: { resource_id: sample.id, action: 'remove_activity_member' } });
      assert.equal(events.length, 1);
      assert.equal(events[0].actor_id, currentOwner);
      assert.equal(events[0].reason, body.reason);
      const snapshot = data => ({ version: data.version, members: data.items.map(({ account_id, member_role }) => ({ account_id, member_role })) });
      assert.deepEqual(events[0].before, snapshot(before));
      assert.deepEqual(events[0].after, snapshot(removed.data));
    });
    await t.test('后台修复到期主负责人，旧版本和资格恢复均不能覆盖现状', async () => {
      const path = '/admin/activities/' + sample.id + '/members';
      const read = '/organizer/activities/' + sample.id + '/members';
      const before = (await teacher.request(read)).data;
      const oldId = (await other.request('/me')).data.account_id;
      const nextId = (await owner.request('/me')).data.account_id;
      const assignments = before.items.map(({ account_id, member_role }) => ({ account_id, member_role }));
      const incoming = { account_id: nextId, member_role: 'collaborator' };
      const add = { expected_version: before.version, require_unavailable_owner: true,
        members: [...assignments, incoming], reason: '补入接任人' };
      const put = (body, key) => teacher.write('PUT', path, body, key);
      const where = { account_id_role: { account_id: oldId, role: 'organizer' } };
      assert.equal((await put(add)).status, 409);
      await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
      assert.equal((await teacher.request(read)).data.owner_unavailable_reason, 'role_expired');
      assert.equal((await other.request(read)).status, 403);
      assert.equal((await other.request('/me/hours')).status, 200);
      assert.equal((await owner.write('PUT', path, add)).status, 403);
      assert.equal((await put({ ...add, members: [...add.members, incoming] })).status, 422);
      const assign = member => ({ ...member, member_role: member.account_id === nextId ? 'owner' : 'collaborator' });
      assert.equal((await put({ ...add, members: add.members.map(assign) })).status, 422);
      const added = await put(add);
      assert.equal(added.status, 200);
      const repair = { ...add, expected_version: added.data.version, members: add.members.map(assign), reason: '老师核对后交接' };
      assert.equal((await put({ ...repair, members: repair.members.filter(m => m.account_id !== oldId) })).status, 422);
      const targetGrant = { account_id_role: { account_id: nextId, role: 'organizer' } };
      await db.roleGrant.update({ where: targetGrant, data: { expires_at: new Date(0) } });
      assert.equal((await put(repair)).status, 422);
      await db.roleGrant.update({ where: targetGrant, data: { expires_at: null } });
      const keys = [randomUUID(), randomUUID()];
      const outcomes = await Promise.all(keys.map(key => put(repair, key)));
      assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
      const winner = outcomes.findIndex(r => r.status === 200);
      assert.deepEqual(await put(repair, keys[winner]), outcomes[winner]);
      const after = (await teacher.request(read)).data;
      assert.equal(after.owner_unavailable_reason, undefined);
      assert.deepEqual(after.items.filter(m => m.member_role === 'owner').map(m => m.account_id), [nextId]);
      assert.equal(after.items.find(m => m.account_id === oldId).member_role, 'collaborator');
      assert.equal((await owner.request(read)).status, 200);
      assert.equal((await other.request(read)).status, 403);
      const events = await db.auditEvent.findMany({ where: { resource_id: sample.id, action: 'set_activity_members', reason: repair.reason } });
      assert.equal(events.length, 1);
      assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
      assert.equal(events[0].before.version + 1, events[0].after.version);
    });
    await t.test('创建后台账号仅限技术管理员，重放和重名不会多建或泄露凭证', async () => {
      const tech = browser(base);
      await tech.signIn('demo.dual', staffPassword);
      const techId = (await tech.request('/me')).data.account_id;
      // The seeded permanent administrator remains available while this grant expires.
      await db.roleGrant.create({ data: { account_id: techId, role: 'tech_admin' } });
      const endpoint = '/admin/staff-accounts';
      const body = { username: 'staff.fixture', display_name: '独立老师', role: 'reviewer', reason: '新教师入职' };
      const key = randomUUID();
      const post = (data, token) => tech.write('POST', endpoint, data, token);
      assert.equal((await teacher.write('POST', endpoint, body)).status, 403);
      assert.equal((await student.write('POST', endpoint, body)).status, 403);
      assert.equal((await post({ ...body, role: 'student' })).status, 422);
      assert.equal((await post({ ...body, reason: '  ' })).status, 422);
      const [created, replay] = await Promise.all([post(body, key), post(body, key)]);
      assert.equal(created.status, 201);
      assert.deepEqual(created, replay);
      assert.deepEqual(Object.keys(created.data).sort(), ['account_id', 'roles', 'version']);
      assert.deepEqual(created.data.roles, [{ role: 'reviewer' }]);
      assert.equal((await post({ ...body, role: 'tech_admin' }, key)).status, 409);
      assert.equal((await post(body)).status, 409);
      const lookup = '/admin/accounts?username=' + body.username;
      assert.equal((await teacher.request(lookup)).data.total, 0);
      const account = (await tech.request(lookup)).data.items[0];
      assert.equal(account.account_id, created.data.account_id);
      assert.equal(account.credential_pending, true);
      assert.equal(account.student_id, undefined);
      const row = await db.account.findUniqueOrThrow({ where: { id: account.account_id } });
      assert.equal(row.password_hash, null);
      const guest = browser(base);
      await guest.request('/auth/csrf');
      assert.equal((await guest.request('/auth/login', { method: 'POST', body: { username: body.username, password: '000002' } })).status, 401);
      const events = await db.auditEvent.findMany({ where: { resource_id: account.account_id, action: 'create_staff_account' } });
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, body.reason);
      assert.deepEqual(events[0].after, { status: 'active', credential_pending: true, roles: [{ role: 'reviewer' }] });
      assert.equal(events[0].actor_id, techId);
      const second = { ...body, username: 'new.technical', role: 'tech_admin' };
      const race = await Promise.all([post(second), post(second)]);
      assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
      // A cached success must not outlive the operator's technical role.
      await db.roleGrant.update({ where: { account_id_role: { account_id: techId, role: 'tech_admin' } }, data: { expires_at: new Date(0) } });
      assert.equal((await post(body, key)).status, 403);

    });
    await t.test('后台账号停用撤销所有会话，重新启用须登录且保留角色历史', async () => {
      const admin = browser(base), secondSession = browser(base);
      await admin.signIn('demo.admin', adminPassword);
      await secondSession.signIn('demo.teacher', staffPassword);
      const originalAdminId = (await admin.request('/me')).data.account_id;
      const teacherId = (await teacher.request('/me')).data.account_id;
      const target = '/admin/accounts/' + teacherId;
      const original = (await admin.request(target)).data;
      const body = { expected_version: original.version, status: 'inactive', reason: '工作交接' };
      const write = (data, key) => admin.write('PATCH', target, data, key);
      assert.equal((await teacher.write('PATCH', target, body)).status, 403);
      const studentId = (await student.request('/me')).data.account_id;
      assert.equal((await admin.write('PATCH', '/admin/accounts/' + studentId, body)).status, 422);
      assert.equal((await write({ ...body, reason: ' ' })).status, 422);
      const roles = (await admin.request(target + '/roles')).data;
      const key = randomUUID();
      const off = await write(body, key);
      assert.equal(off.status, 200);
      assert.deepEqual(off.data, { ...original, version: original.version + 1, status: 'inactive' });
      assert.deepEqual(await write(body, key), off);
      assert.deepEqual((await write({ ...body, expected_version: off.data.version })).data, off.data);
      assert.equal((await write(body)).code, 'version_conflict');
      assert.equal((await teacher.request('/me')).status, 401);
      assert.equal((await secondSession.request('/me')).status, 401);
      await secondSession.request('/auth/csrf');
      assert.equal((await secondSession.request('/auth/login', { method: 'POST', body: { username: 'demo.teacher', password: staffPassword } })).status, 401);
      const on = await write({ expected_version: off.data.version, status: 'active', reason: '恢复履职' });
      assert.deepEqual(on.data, { ...original, version: off.data.version + 1 });
      assert.deepEqual((await admin.request(target + '/roles')).data, roles);
      assert.equal((await teacher.request('/me')).status, 401);
      await teacher.signIn('demo.teacher', staffPassword);
      assert.equal((await teacher.request('/me')).data.account_id, teacherId);
      const events = await db.auditEvent.findMany({ where: { resource_id: teacherId, action: 'set_account_status' }, orderBy: { created_at: 'asc' } });
      assert.deepEqual(events.map(e => [e.reason, e.before.status, e.after.status]), [
        ['工作交接', 'active', 'inactive'], ['恢复履职', 'inactive', 'active'],
      ]);
      assert.ok(events.every(e => e.actor_id === originalAdminId));
    });

    await t.test('并发停用两个永久管理员只成功一次，限期和待发凭证的账号不能兜底', async () => {
      const permanent = browser(base), backup = browser(base);
      await permanent.signIn('demo.admin', adminPassword);
      await backup.signIn('demo.dual', staffPassword);
      const ids = [(await permanent.request('/me')).data.account_id, (await backup.request('/me')).data.account_id];
      const where = { account_id_role: { account_id: ids[1], role: 'tech_admin' } };
      await db.roleGrant.update({ where, data: { expires_at: new Date(Date.now() + 86400000) } });
      const body = { expected_version: 1, status: 'inactive', reason: '管理员交班' };
      const paths = ids.map(id => '/admin/accounts/' + id);
      assert.equal((await permanent.write('PATCH', paths[0], body)).code, 'invalid_state');
      assert.equal((await permanent.request('/me')).status, 200);
      await db.roleGrant.update({ where, data: { expires_at: null } });
      const clients = [permanent, backup];
      const results = await Promise.all(clients.map((client, i) => client.write('PATCH', paths[i], body)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const disabled = results.findIndex(r => r.status === 200), kept = 1 - disabled;
      assert.equal((await clients[disabled].request('/me')).status, 401);
      assert.equal((await clients[kept].request('/me')).status, 200);
      assert.equal(await db.auditEvent.count({ where: { action: 'set_account_status', resource_id: { in: ids } } }), 1);
      assert.equal((await clients[kept].write('PATCH', paths[disabled], {
        status: 'active', expected_version: results[disabled].data.version, reason: '恢复履职',
      })).status, 200);
      await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
    });
    await t.test('账号只读范围先于分页，角色和详情不泄露高权限资料', async () => {
      const expires = new Date('2099-12-31T15:59:00Z');
      const create = (username, roles) => db.account.create({ data: {
        username, display_name: '合成同名', password_hash: 'not-a-login', roles_version: 3,
        student: { create: { student_no: username } },
        roles: { create: roles.map(role => ({ role, ...(role === 'organizer' && { expires_at: expires }) })) },
      } });
      const hidden = await create('0999000001', ['student', 'tech_admin']);
      const firstVisible = await create('0999000002', ['student', 'organizer']);
      await create('0999000003', ['student']);
      const path = '/admin/accounts';
      const lookup = query => teacher.request(path + '?' + new URLSearchParams(query));
      const exact = (await lookup({ q: firstVisible.username })).data;
      assert.equal(exact.total, 1);
      assert.deepEqual(exact.items.map(item => item.account_id), [firstVisible.id]);
      const page = (await lookup({ q: '合成同名', page_size: 1 })).data;
      assert.equal(page.total, 2);
      assert.equal(page.items[0].username, firstVisible.username);
      assert.equal((await lookup({ q: hidden.username })).data.total, 0);
      assert.equal((await lookup({ q: '合成同名', role: 'organizer', status: 'active' })).data.total, 1);
      assert.equal((await lookup({ role: 'other' })).status, 422);
      assert.equal((await student.request(path)).status, 403);
      for (const suffix of ['', '/roles']) {
        assert.equal((await teacher.request(path + '/' + hidden.id + suffix)).status, 403);
      }
      const detail = (await teacher.request(path + '/' + firstVisible.id)).data;
      assert.deepEqual(Object.keys(detail).sort(), ['account_id','display_name','roles','status','student_id','student_version','username','version']);
      const grants = (await teacher.request(path + '/' + firstVisible.id + '/roles')).data;
      assert.equal(grants.version, 3);
      assert.equal(detail.version, 1);
      assert.deepEqual(grants.roles, [{ role:'student' }, { role:'organizer', expires_at:expires.toISOString() }]);
    });
    await t.test('资格授予、到期和回收立即作用于原会话，角色并发及重放只记一次', async (t) => {
      const { account_id } = (await student.request('/me')).data;
      const path = '/admin/accounts/' + account_id + '/roles';
      const original = (await teacher.request(path)).data;
      const now = Date.now(), expires_at = new Date(now + 120000).toISOString();
      t.mock.timers.enable({ apis:['Date'], now });
      const body = { expected_version: original.version, reason:'合成授权核对',
        roles:[...original.roles, { role:'organizer', expires_at }] };
      const key = randomUUID();
      const put = (payload, token) => teacher.write('PUT', path, payload, token);
      assert.equal((await student.write('PUT', path, body)).status, 403);
      for (const roles of [[], [{role:'student', expires_at}], [...original.roles, {role:'reviewer'}]]) {
        assert.equal((await put({...body, roles})).status, 403);
      }
      const writes = await Promise.all([put(body, key), put(body, key)]);
      assert.equal(writes[0].status, 200);
      assert.deepEqual(writes[0], writes[1]);
      assert.equal((await put({...body, reason:'不同内容'}, key)).code, 'conflict');
      assert.equal((await put(body)).code, 'version_conflict');
      const managed = () => student.request('/organizer/activities');
      assert.equal((await managed()).status, 200);
      assert.equal((await student.request('/organizer/activities/' + sample.id + '/registrations')).status, 404);
      t.mock.timers.setTime(Date.parse(expires_at));
      assert.deepEqual((await student.request('/me')).data.roles, ['student']);
      assert.equal((await managed()).status, 403);
      const permanent = {...body, expected_version:writes[0].data.version, roles:[...original.roles, {role:'organizer'}]};
      const renewals = await Promise.all([put(permanent), put(permanent)]);
      assert.deepEqual(renewals.map(result => result.status).sort(), [200,409]);
      assert.equal((await managed()).status, 200);
      const revoked = await put({...body, expected_version:permanent.expected_version + 1, roles:original.roles});
      assert.equal(revoked.status, 200);
      assert.equal((await managed()).status, 403);
      assert.equal((await student.request('/me/registrations')).status, 200);
      const events = await db.auditEvent.findMany({where:{resource_id:account_id, action:'set_account_roles'}, orderBy:{created_at:'asc'}});
      assert.equal(events.length, 3);
      assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
      assert.equal(events[0].reason, body.reason);
      assert.deepEqual(events[0].before, {roles:original.roles});
      assert.deepEqual(events[0].after, {roles:body.roles});
      await db.roleGrant.create({data:{account_id, role:'reviewer'}});
      assert.equal((await put(body, key)).status, 403);
    });
    await t.test('高权限授权按角色版本生效，老师原会话在到期和收回后立即恢复原范围', async (t) => {
      const admin = browser(base);
      await admin.signIn('demo.admin', adminPassword);
      const adminId = (await admin.request('/me')).data.account_id;
      const teacherId = (await teacher.request('/me')).data.account_id;
      const target = '/admin/accounts/' + teacherId;
      const path = target + '/roles';
      const privileged = '/admin/accounts/' + adminId;
      const original = (await admin.request(path)).data;
      const accountVersion = (await admin.request(target)).data.version;
      const now = Date.now(), expires_at = new Date(now + 120000).toISOString();
      t.mock.timers.enable({ apis: ['Date'], now });
      const body = { expected_version: original.version, reason: '临时技术值班',
        roles: [...original.roles, { role: 'tech_admin', expires_at }] };
      assert.equal((await teacher.write('PUT', path, body)).status, 403);
      const key = randomUUID();
      const issued = await admin.write('PUT', path, body, key);
      assert.equal(issued.status, 200);
      assert.deepEqual(await admin.write('PUT', path, body, key), issued);
      assert.equal((await admin.write('PUT', path, body)).code, 'version_conflict');
      assert.equal((await teacher.request(privileged)).status, 200);
      t.mock.timers.setTime(Date.parse(expires_at));
      assert.equal((await teacher.request(privileged)).status, 403);
      assert.deepEqual((await teacher.request('/me')).data.roles, ['reviewer']);
      const renew = { ...body, expected_version: issued.data.version, roles: [...original.roles, { role: 'tech_admin' }] };
      assert.equal((await admin.write('PUT', path, renew)).status, 200);
      assert.equal((await teacher.request(privileged)).status, 200);
      const revoked = await admin.write('PUT', path, { ...body, roles: original.roles, expected_version: renew.expected_version + 1 });
      assert.deepEqual(revoked.data, { ...original, version: original.version + 3 });
      assert.equal((await teacher.request(privileged)).status, 403);
      assert.equal((await admin.request(target)).data.version, accountVersion);
      const events = await db.auditEvent.findMany({ where: { resource_id: teacherId, action: 'set_account_roles' } });
      assert.equal(events.length, 3);
      const issuedEvent = events.find(e => e.after.roles.some(g => g.expires_at === expires_at));
      assert.equal(issuedEvent.actor_id, adminId);
      assert.equal(issuedEvent.reason, body.reason);
      assert.deepEqual(issuedEvent.before, { roles: original.roles });
      assert.deepEqual(issuedEvent.after, { roles: body.roles });
    });
    await t.test('办理老师审核员角色时保留原学生身份和已到期的其他角色', async () => {
      const admin = browser(base);
      await admin.signIn('demo.admin', adminPassword);
      const path = '/admin/accounts/' + (await other.request('/me')).data.account_id + '/roles';
      const original = (await admin.request(path)).data;
      const set = (version, roles) => admin.write('PUT', path, { expected_version: version, roles, reason: '审核轮岗' });
      assert.equal((await set(original.version, [{ role: 'reviewer' }])).status, 403);
      const updated = await set(original.version, [...original.roles, { role: 'reviewer' }]);
      assert.equal(updated.status, 200);
      assert.equal((await other.request('/admin/accounts')).status, 200);
      assert.equal((await other.request('/me/hours')).status, 200);
      const restored = await set(updated.data.version, original.roles);
      assert.deepEqual(restored.data.roles, original.roles);
      assert.equal((await other.request('/admin/accounts')).status, 403);
    });
    await t.test('限期、撤权和停用并发时保留一个长期管理员，失败的写入不改变角色或状态', async () => {
      const admin = browser(base);
      await admin.signIn('demo.admin', adminPassword);
      const primary = '/admin/accounts/' + (await admin.request('/me')).data.account_id;
      const backup = '/admin/accounts/' + (await teacher.request('/me')).data.account_id;
      const expires_at = new Date(Date.now() + 86400000).toISOString();
      const set = (client, path, version, roles) => client.write('PUT', path + '/roles', {
        expected_version: version, reason: '管理员轮值', roles,
      });
      const state = async path => (await admin.request(path + '/roles')).data;
      const primaryRoles = (await state(primary)).roles;
      const backupRoles = (await state(backup)).roles;
      const limited = primaryRoles.map(g => g.role === 'tech_admin' ? { ...g, expires_at } : g);
      const sole = await state(primary);
      assert.equal((await set(admin, primary, sole.version, sole.roles.filter(g => g.role !== 'tech_admin'))).code, 'invalid_state');
      assert.deepEqual(await state(primary), sole);
      for (const operation of ['revoke', 'disable']) {
        const original = await state(backup);
        const granted = await set(admin, backup, original.version, [...backupRoles, { role: 'tech_admin' }]);
        assert.equal(granted.status, 200);
        const primaryVersion = (await state(primary)).version;
        const accountVersion = (await admin.request(backup)).data.version;
        const results = await Promise.all([
          set(admin, primary, primaryVersion, limited),
          operation === 'revoke' ? set(teacher, backup, granted.data.version, backupRoles)
            : teacher.write('PATCH', backup, { expected_version: accountVersion, status: 'inactive', reason: '值班交接' }),
        ]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
        assert.equal(results.find(r => r.status === 409).code, 'invalid_state');
        const primaryWon = results[0].status === 200;
        assert.deepEqual((await state(primary)).roles, primaryWon ? limited : primaryRoles);
        const backupState = await state(backup);
        assert.deepEqual(backupState.roles, !primaryWon && operation === 'revoke' ? backupRoles : granted.data.roles);
        assert.equal((await admin.request(backup)).data.status, !primaryWon && operation === 'disable' ? 'inactive' : 'active');
        if (primaryWon) assert.equal((await set(admin, primary, primaryVersion + 1, primaryRoles)).status, 200);
        if (!primaryWon && operation === 'disable') {
          assert.equal((await admin.write('PATCH', backup, {
            expected_version: accountVersion + 1, status: 'active', reason: '恢复履职',
          })).status, 200);
          await teacher.signIn('demo.teacher', staffPassword);
        }
        assert.equal((await set(admin, backup, backupState.version, backupRoles)).status, 200);
      }
    });
    await t.test('档案修正使用学生版本，旧状态表单须重新核对，姓名和班级修正脱敏记录', async () => {
      const row = (await teacher.request('/admin/students?q=0999000003')).data.items[0];
      const path = '/admin/students/' + row.id;
      const patch = { expected_version: row.version, reason: '核对学院档案', name: '合成测试学生', class_name: '0123456789' };
      assert.equal((await teacher.write('PATCH', path, { ...patch, class_name: '123' })).status, 422);
      const changed = await teacher.write('PATCH', path, patch);
      assert.equal(changed.status, 200);
      assert.equal(changed.data.class_name, patch.class_name);
      assert.equal((await teacher.write('PATCH', path, { expected_version: row.version, reason: '旧表单', status: 'inactive' })).code, 'version_conflict');
      assert.equal((await teacher.request('/admin/accounts/' + row.account_id)).data.status, 'active');
      const event = await db.auditEvent.findFirstOrThrow({ where: { resource_id: row.id, action: 'update_student' } });
      assert.equal(event.after.class_name, '******6789');
      assert.equal(event.after.name, '合＊');
      assert.equal(event.after.version, row.version + 1);
    });
    await t.test('老师停用与恢复学生负责人需核实试点范围，两份旧会话失效且身份和报名历史保留', async () => {
      const second = browser(base);
      await second.signIn('0000000002', ownerPassword);
      const me = (await owner.request('/me')).data;
      const id = me.student.id;
      const accountPath = '/admin/accounts/' + me.account_id;
      const path = '/admin/students/' + id;
      const before = (await teacher.request(accountPath)).data;
      const roles = (await teacher.request(accountPath + '/roles')).data;
      const history = await db.registration.findMany({ where: { student_id: id } });
      const off = { expected_version: before.student_version, status: 'inactive', reason: '本期暂停参加试点' };
      const key = randomUUID();
      assert.equal((await owner.write('PATCH', path, off)).status, 403);
      const results = await Promise.all([teacher.write('PATCH', path, off, key), teacher.write('PATCH', path, off, key)]);
      assert.equal(results[0].status, 200);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].data.version, before.student_version + 1);
      assert.equal((await teacher.write('PATCH', path, off)).code, 'version_conflict');
      assert.equal((await owner.request('/me')).status, 401);
      assert.equal((await second.request('/me')).status, 401);
      await second.request('/auth/csrf');
      assert.equal((await second.request('/auth/login', { method: 'POST', body: { username: me.username, password: ownerPassword } })).status, 401);
      const on = { expected_version: results[0].data.version, status: 'active', reason: '已核对本期学院名单' };
      for (const flag of [{}, { pilot_scope_verified: false }])
        assert.equal((await teacher.write('PATCH', path, { ...on, ...flag })).status, 422);
      assert.equal((await teacher.write('PATCH', path, { ...on, pilot_scope_verified: true })).status, 200);
      assert.equal((await second.request('/me')).status, 401);
      assert.equal((await owner.request('/me')).status, 401);
      await owner.signIn(me.username, ownerPassword);
      assert.equal((await owner.request('/me/hours')).status, 200);
      assert.deepEqual((await teacher.request(accountPath + '/roles')).data, roles);
      assert.deepEqual(await db.registration.findMany({ where: { student_id: id } }), history);
      assert.deepEqual((await teacher.request(accountPath)).data, { ...before, student_version: before.student_version + 2, version: before.version + 2 });
      const events = await db.auditEvent.findMany({ where: { resource_id: id, action: 'update_student' }, orderBy: { created_at: 'asc' } });
      assert.deepEqual(events.map(e => [e.before.status, e.after.status, e.reason]), [
        ['active', 'inactive', off.reason], ['inactive', 'active', on.reason],
      ]);
      assert.equal(events[1].after.pilot_scope_verified, true);
      assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
      await db.roleGrant.create({ data: { account_id: me.account_id, role: 'reviewer' } });
      assert.equal((await teacher.write('PATCH', path, off, key)).status, 403);
      await db.roleGrant.delete({ where: { account_id_role: { account_id: me.account_id, role: 'reviewer' } } });
    });

    await t.test('学生档案停用与另一管理员改限期并发，仅能失去一名长期管理员', async () => {
      const admin = browser(base);
      await admin.signIn('demo.admin', adminPassword);
      const primaryPath = '/admin/accounts/' + (await admin.request('/me')).data.account_id + '/roles';
      const me = (await owner.request('/me')).data;
      const target = '/admin/accounts/' + me.account_id;
      const studentPath = '/admin/students/' + me.student.id;
      const primary = (await admin.request(primaryPath)).data;
      const original = (await admin.request(target + '/roles')).data;
      const grant = await admin.write('PUT', target + '/roles', { expected_version: original.version,
        roles: [...original.roles, {role: 'tech_admin'}], reason: '管理员轮值' });
      assert.equal(grant.status, 200);
      const status = { expected_version: (await admin.request(target)).data.student_version, status: 'inactive', reason: '结束轮值' };
      const expires_at = new Date(Date.now() + 86400000).toISOString();
      const results = await Promise.all([
        admin.write('PUT', primaryPath, { expected_version: primary.version, reason: '临时值班',
          roles: primary.roles.map(g => g.role === 'tech_admin' ? { ...g, expires_at } : g) }),
        owner.write('PATCH', studentPath, status),
      ]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      assert.equal(results.find(r => r.status === 409).code, 'invalid_state');
      if (results[0].status === 200) {
        assert.equal((await owner.request('/me')).status, 200);
        assert.equal((await admin.write('PUT', primaryPath, { expected_version: primary.version + 1, roles: primary.roles, reason: '恢复轮值' })).status, 200);
      } else {
        assert.equal((await owner.request('/me')).status, 401);
        assert.equal((await admin.write('PATCH', studentPath, { expected_version: status.expected_version + 1,
          status: 'active', pilot_scope_verified: true, reason: '重新核对试点名单' })).status, 200);
        await owner.signIn(me.username, ownerPassword);
      }
      assert.equal((await admin.write('PUT', target + '/roles', { expected_version: grant.data.version,
        roles: original.roles, reason: '结束轮值' })).status, 200);
    });

    await t.test('老师核验后重置普通负责人凭证，旧密码和全部会话作废', async () => {
      const second = browser(base), admin = browser(base);
      await second.signIn('0000000002', ownerPassword);
      await admin.signIn('demo.admin', adminPassword);
      const id = (await owner.request('/me')).data.account_id;
      const path = '/admin/accounts/' + id;
      const before = (await teacher.request(path)).data;
      const body = { expected_version: before.version, reason: '本人申请找回凭证' };
      const reset = (actor, data, key) => actor.write('POST', path + '/password-reset', data, key);
      assert.equal((await reset(owner, body)).status, 403);
      assert.equal((await reset(teacher, { ...body, reason: ' ' })).status, 422);
      assert.equal((await reset(teacher, { ...body, expected_version: before.version + 1 })).code, 'version_conflict');
      const key = randomUUID();
      const results = await Promise.all([reset(teacher, body, key), reset(teacher, body, key)]);
      assert.equal(results[0].status, 200);
      assert.deepEqual(results[0], results[1]);
      assert.deepEqual(results[0].data, { completed: true, resource_id: id, version: before.version + 1 });
      assert.deepEqual((await teacher.request(path)).data, { ...before, credential_pending: true, version: before.version + 1 });
      assert.equal((await owner.request('/me')).status, 401);
      assert.equal((await second.request('/me')).status, 401);
      await second.request('/auth/csrf');
      for (const secret of [ownerPassword, '000002'])
        assert.equal((await second.request('/auth/login', { method: 'POST', body: { username: '0000000002', password: secret } })).status, 401);
      const events = await db.auditEvent.findMany({ where: { resource_id: id, action: 'reset_password' } });
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, body.reason);
      assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
      assert.deepEqual(events[0].before, { version: before.version, credential_pending: false });
      assert.deepEqual(events[0].after, { version: before.version + 1, credential_pending: true });
      await db.roleGrant.create({ data: { account_id: id, role: 'reviewer', expires_at: new Date(0) } });
      assert.equal((await reset(teacher, body, key)).status, 403);
      const teacherId = (await teacher.request('/me')).data.account_id;
      const staffPath = '/admin/accounts/' + teacherId;
      const staffBody = { expected_version: (await admin.request(staffPath)).data.version, reason: '老师本人申请' };
      assert.equal((await teacher.write('POST', staffPath + '/password-reset', staffBody)).status, 403);
      assert.equal((await admin.write('POST', staffPath + '/password-reset', staffBody)).status, 200);
      assert.equal((await teacher.request('/me')).status, 401);
    });
    await t.test('重置与停用并发仍保留一个可用永久管理员', async () => {
      const primary = browser(base), backup = browser(base);
      await primary.signIn('demo.admin', adminPassword);
      await backup.signIn('demo.dual', staffPassword);
      const id = (await primary.request('/me')).data.account_id;
      const otherId = (await backup.request('/me')).data.account_id;
      const path = '/admin/accounts/' + id, otherPath = '/admin/accounts/' + otherId;
      const body = { expected_version: (await primary.request(path)).data.version, reason: '核对管理员凭证' };
      assert.equal((await primary.write('POST', path + '/password-reset', body)).code, 'invalid_state');
      assert.equal((await primary.request('/me')).status, 200);
      await db.roleGrant.update({ where: { account_id_role: { account_id: otherId, role: 'tech_admin' } }, data: { expires_at: null } });
      const change = { status: 'inactive', expected_version: (await backup.request(otherPath)).data.version, reason: '管理员轮岗' };
      const results = await Promise.all([primary.write('POST', path + '/password-reset', body), backup.write('PATCH', otherPath, change)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const clients = [primary, backup];
      for (const [i, result] of results.entries())
        assert.equal((await clients[i].request('/me')).status, result.status === 200 ? 401 : 200);
    });
  } finally {
    await app?.close();
  }
});
