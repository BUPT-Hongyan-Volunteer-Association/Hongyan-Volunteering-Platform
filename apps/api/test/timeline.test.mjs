import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';
import { browser } from './api-client.mjs';

const day = 86_400_000;
const iso = (value) => new Date(value).toISOString();
const at = (date, time) => date + 'T' + time + ':00+08:00';
const beijing = (value) => new Date(value + 8 * 3600_000).toISOString().slice(0, 10);

function hash(id) {
  let value = 2166136261;
  for (const byte of new TextEncoder().encode(id.toLowerCase()))
    value = Math.imul(value ^ byte, 16777619);
  return (value >>> 0) % 6;
}

test('活动日程按范围、版本与窗口返回真实安排', { timeout: 180000 }, async (t) => {
  const staffPassword = randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword });
  let app;
  try {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const [student, owner, outsider, teacher] = Array.from({ length: 4 }, () => browser(base));
    await Promise.all([
      student.signIn('0000000001', '000001', 't1' + randomUUID()),
      owner.signIn('0000000002', '000002', 't1' + randomUUID()),
      outsider.signIn('0000000003', '000003', 't1' + randomUUID()),
      teacher.signIn('demo.teacher', staffPassword),
    ]);
    const studentRow = await db.student.findUniqueOrThrow({ where: { student_no: '0000000001' } });
    const first = await db.activity.findUniqueOrThrow({
      where: { activity_code: 'P2026-0001' },
      include: { revisions: true, members: true },
    });
    const template = first.revisions[0].content;
    const ownerId = first.members.find((m) => m.member_role === 'owner').account_id;
    const now = Date.now();
    const from = now - 2 * day,
      to = now + 12 * day;
    const anchor = beijing(now + 3 * day);
    const before = beijing(now + 2 * day);
    const window = 'from=' + iso(from) + '&to=' + iso(to);

    const create = (code, title, schedule, status = 'published') =>
      db.activity.create({
        data: {
          activity_code: code,
          status,
          working_revision: 1,
          published_revision: 1,
          members: { create: { account_id: ownerId, member_role: 'owner' } },
          revisions: {
            create: {
              revision: 1,
              revision_state: 'approved',
              approved_at: new Date(),
              created_by: ownerId,
              content: { ...template, title, schedule },
            },
          },
        },
      });

    const multi = await create('TL-0001', '多时段演示', {
      schedule_type: 'custom',
      duration_start_date: before,
      duration_end_date: anchor,
      slots: [
        { starts_at: at(before, '09:15'), ends_at: at(before, '11:30') },
        { starts_at: at(anchor, '09:30'), ends_at: at(anchor, '10:45') },
        { starts_at: at(anchor, '14:15'), ends_at: at(anchor, '15:45') },
      ],
    });
    const ongoing = await create('TL-0002', '正在进行演示', {
      schedule_type: 'continuous',
      starts_at: iso(now - 3600_000),
      ends_at: iso(now + 3600_000),
    });
    const done = await create('TL-0003', '已结束演示', {
      schedule_type: 'continuous',
      starts_at: iso(now - day),
      ends_at: iso(now - day + 7200_000),
    }, 'completed');
    await db.activity.create({
      data: {
        activity_code: 'TL-0004',
        status: 'draft',
        working_revision: 1,
        members: { create: { account_id: ownerId, member_role: 'owner' } },
        revisions: {
          create: {
            revision: 1,
            revision_state: 'draft',
            created_by: ownerId,
            content: {
              ...template,
              title: '工作稿演示',
              schedule: {
                schedule_type: 'continuous',
                starts_at: iso(now + day),
                ends_at: iso(now + day + 3600_000),
              },
            },
          },
        },
      },
    });
    // 获批版本正在进行，工作版本已改为未来时间并送审。
    const revised = await create('TL-0005', '待审修订演示', {
      schedule_type: 'continuous',
      starts_at: iso(now - 1800_000),
      ends_at: iso(now + 1800_000),
    });
    await db.activityRevision.create({
      data: {
        activity_id: revised.id,
        revision: 2,
        revision_state: 'pending_review',
        created_by: ownerId,
        content: {
          ...template,
          title: '待审修订演示',
          schedule: {
            schedule_type: 'continuous',
            starts_at: iso(now + 5 * day),
            ends_at: iso(now + 5 * day + 5400_000),
          },
        },
      },
    });
    await db.activity.update({ where: { id: revised.id }, data: { working_revision: 2 } });
    const review = await db.activityReview.create({
      data: { activity_id: revised.id, revision: 2, submitted_by: ownerId },
    });
    // 已取消活动与本人已录取安排重叠：两侧都不应产生计划重叠提示。
    const cancelled = await create(
      'TL-0007',
      '已取消重叠演示',
      {
        schedule_type: 'custom',
        duration_start_date: anchor,
        duration_end_date: anchor,
        slots: [{ starts_at: at(anchor, '09:45'), ends_at: at(anchor, '10:30') }],
      },
      'cancelled',
    );
    const timeline = (client, query) => client.request('/timeline?' + query);
    const codes = (response) => response.data.items.map((item) => item.activity_code).sort();
    const publicQuery = (extra = '') => timeline(student, 'scope=public&' + window + extra);

    await t.test('公开范围只返回获批版本且不含管理字段', async () => {
      const response = await publicQuery();
      assert.equal(response.status, 200, JSON.stringify(response));
      const items = response.data.items;
      assert.deepEqual(codes(response), ['P2026-0001', 'TL-0001', 'TL-0002', 'TL-0005']);
      assert.equal(response.data.total, 4);
      for (const item of items) {
        assert.equal(item.has_pending_review, undefined);
        assert.equal(item.current_review_id, undefined);
        assert.equal(item.revision_state, 'approved');
        assert.ok(item.segments.every((segment) => segment.revision_state === 'approved'));
        assert.equal(item.state_evaluated_at, response.data.state_evaluated_at);
      }
      const multiItem = items.find((item) => item.activity_code === 'TL-0001');
      assert.equal(multiItem.segments.length, 3);
      assert.deepEqual(
        multiItem.segments.map((segment) => segment.starts_at),
        [at(before, '09:15'), at(anchor, '09:30'), at(anchor, '14:15')],
      );
      assert.equal(multiItem.color_index, hash(multi.id));
      assert.equal(multiItem.schedule_type, 'custom');
    });

    await t.test('普通学生不能经参数读取工作稿或后台筛选', async () => {
      assert.equal((await publicQuery('&revision_scope=working')).status, 403);
      assert.equal((await publicQuery('&review_status=pending_review')).status, 403);
      assert.equal(
        (await publicQuery('&owner_account_id=' + ownerId)).status,
        403,
      );
      assert.equal((await timeline(student, 'scope=managed&' + window)).status, 403);
      assert.equal((await timeline(outsider, 'scope=all&' + window)).status, 403);
    });

    await t.test('窗口必填、成对且不超过 31 日', async () => {
      assert.equal((await timeline(student, 'scope=public&from=' + iso(from))).status, 422);
      assert.equal(
        (await timeline(student, 'scope=public&from=' + iso(to) + '&to=' + iso(from))).status,
        422,
      );
      assert.equal(
        (await timeline(student, 'scope=public&from=' + iso(from) + '&to=' + iso(from + 32 * day)))
          .status,
        422,
      );
      const last = await timeline(
        student,
        'scope=public&from=' + iso(from) + '&to=' + iso(from + 31 * day),
      );
      assert.equal(last.status, 200);
    });

    await t.test('公开范围按生命周期筛选，默认只显示已发布', async () => {
      const completed = await publicQuery('&status=completed');
      assert.deepEqual(codes(completed), ['TL-0003']);
      const cancelled = await publicQuery('&status=cancelled');
      assert.deepEqual(codes(cancelled), ['TL-0007']);
      assert.equal((await publicQuery('&status=draft')).status, 422);
      const ongoingOnly = await publicQuery('&is_ongoing=true');
      assert.deepEqual(codes(ongoingOnly), ['TL-0002', 'TL-0005']);
    });

    await t.test('本人日程在退出申请待处理期间保留获批时段，退出获批后移除', async () => {
      await db.registration.create({
        data: { activity_id: ongoing.id, student_id: studentRow.id, status: 'withdrawn' },
      });
      const empty = await timeline(student, 'scope=mine&' + window);
      assert.equal(empty.status, 200);
      assert.equal(empty.data.total, 0);
      assert.ok(Number.isFinite(Date.parse(empty.data.state_evaluated_at)));
      const relation = { activity_id: multi.id, student_id: studentRow.id };
      const registration = await db.registration.create({
        data: { ...relation, status: 'accepted' },
      });
      const mine = await timeline(student, 'scope=mine&' + window);
      assert.deepEqual(codes(mine), ['TL-0001']);
      assert.equal(mine.data.items[0].has_pending_review, undefined);
      const request = await db.exitRequest.create({
        data: { registration_id: registration.id, reason: '课程安排冲突' },
        include: { registration: true },
      });
      assert.equal(request.status, 'pending');
      assert.equal(request.registration.status, 'accepted');
      const pending = await timeline(student, 'scope=mine&' + window);
      assert.equal(pending.status, 200);
      assert.equal(pending.data.total, 1);
      const [activity] = pending.data.items;
      assert.equal(activity.activity_id, multi.id);
      assert.equal(activity.revision_state, 'approved');
      assert.deepEqual(activity.segments, mine.data.items[0].segments);

      await db.$transaction([
        db.exitRequest.update({ where: { id: request.id }, data: { status: 'approved', version: 2 } }),
        db.registration.update({ where: { id: registration.id }, data: { status: 'exited' } }),
      ]);
      const exited = await timeline(student, 'scope=mine&' + window);
      assert.equal(exited.status, 200);
      assert.equal(exited.data.total, 0);
      assert.deepEqual(exited.data.items, []);
      await db.registration.update({ where: { id: registration.id }, data: { status: 'accepted' } });
      assert.deepEqual(codes(await timeline(student, 'scope=mine&' + window)), ['TL-0001']);
    });

    await t.test('负责人仅见本人管理的活动，后台按授权读取工作版本', async () => {
      const managed = await timeline(owner, 'scope=managed&' + window);
      assert.equal(managed.status, 200);
      assert.ok(codes(managed).includes('TL-0001'));
      assert.ok(codes(managed).includes('TL-0004'));
      // 另一位负责人只看到自己管理的活动，看不到他人活动。
      const other = await timeline(outsider, 'scope=managed&' + window);
      assert.deepEqual(codes(other), ['P2026-0002']);

      const all = await timeline(teacher, 'scope=all&' + window);
      assert.ok(codes(all).includes('P2026-0002'));
      assert.ok(codes(all).includes('TL-0004'));
      const pending = all.data.items.find((item) => item.activity_code === 'P2026-0002');
      assert.equal(pending.has_pending_review, true);
      assert.equal(typeof pending.current_review_id, 'string');

      const published = await timeline(teacher, 'scope=all&' + window + '&revision_scope=published');
      assert.equal(codes(published).includes('P2026-0002'), false);
      assert.equal(codes(published).includes('TL-0004'), false);
    });

    await t.test('进行中始终按获批安排，内容与分段取所选版本', async () => {
      const working = await timeline(teacher, 'scope=all&' + window);
      const item = working.data.items.find((row) => row.activity_code === 'TL-0005');
      assert.equal(item.revision_state, 'pending_review');
      assert.equal(item.schedule_revision, 2);
      assert.equal(item.has_pending_review, true);
      assert.equal(item.current_review_id, review.id);
      assert.equal(item.is_ongoing, true);
      assert.equal(Date.parse(item.segments[0].starts_at) > Date.now(), true);

      const approved = await timeline(
        teacher,
        'scope=all&' + window + '&revision_scope=published',
      );
      const published = approved.data.items.find((row) => row.activity_code === 'TL-0005');
      assert.equal(published.revision_state, 'approved');
      assert.equal(published.schedule_revision, 1);
      assert.equal(published.is_ongoing, true);
      assert.equal(published.segments.length, 1);
    });

    await t.test('审核状态筛选按当前工作版本，独立于展示版本', async () => {
      const pending = await timeline(
        teacher,
        'scope=all&' + window + '&revision_scope=published&review_status=pending_review',
      );
      // 没有获批版本的活动不进入获批视图，即使它有待审对象。
      assert.deepEqual(codes(pending), ['TL-0005']);
      assert.ok(pending.data.items.every((item) => item.revision_state === 'approved'));
      const approvedOnly = await timeline(teacher, 'scope=all&' + window + '&review_status=approved');
      assert.equal(codes(approvedOnly).some((code) => code === 'TL-0005'), false);
    });

    await t.test('先筛选后按活动分页，total 为活动数', async () => {
      const firstPage = await publicQuery('&page=1&page_size=2');
      assert.equal(firstPage.data.total, 4);
      assert.equal(firstPage.data.items.length, 2);
      assert.equal(firstPage.data.page_size, 2);
      const secondPage = await publicQuery('&page=2&page_size=2');
      assert.equal(secondPage.data.items.length, 2);
      assert.deepEqual(
        [...firstPage.data.items, ...secondPage.data.items].map((item) => item.activity_code).sort(),
        ['P2026-0001', 'TL-0001', 'TL-0002', 'TL-0005'],
      );
      const third = await publicQuery('&page=3&page_size=2');
      assert.equal(third.data.items.length, 0);
      assert.equal(third.data.total, 4);
      assert.ok(Number.isFinite(Date.parse(third.data.state_evaluated_at)));
      const searched = await publicQuery('&q=' + encodeURIComponent('多时段演示'));
      assert.deepEqual(codes(searched), ['TL-0001']);
    });

    await t.test('分段按窗口相交返回完整真实起止', async () => {
      const narrow = await timeline(
        student,
        'scope=public&from=' + iso(Date.parse(at(anchor, '00:00')) - 3600_000) +
          '&to=' + iso(Date.parse(at(anchor, '23:59'))),
      );
      const item = narrow.data.items.find((row) => row.activity_code === 'TL-0001');
      assert.equal(item.segments.length, 2);
      assert.deepEqual(
        item.segments.map((segment) => [segment.starts_at, segment.ends_at]),
        [
          [at(anchor, '09:30'), at(anchor, '10:45')],
          [at(anchor, '14:15'), at(anchor, '15:45')],
        ],
      );
      assert.equal(item.segments[0].occurrence_key.startsWith(multi.id + '/1/'), true);
    });

    await t.test('后台按负责人筛选，兼管范围不外扩', async () => {
      const filtered = await timeline(
        teacher,
        'scope=all&' + window + '&owner_account_id=' + ownerId,
      );
      assert.equal(filtered.status, 200);
      assert.ok(filtered.data.items.every((item) => item.owner_account_id === ownerId));
      const none = await timeline(teacher, 'scope=all&' + window + '&owner_account_id=' + randomUUID());
      assert.equal(none.data.total, 0);
    });

    await t.test('计划重叠只作本人范围的提示', async () => {
      const studentRow2 = await db.student.findUniqueOrThrow({ where: { student_no: '0000000004' } });
      await db.registration.create({
        data: { activity_id: multi.id, student_id: studentRow2.id, status: 'accepted' },
      });
      const clash = await create('TL-0006', '重叠演示', {
        schedule_type: 'custom',
        duration_start_date: anchor,
        duration_end_date: anchor,
        slots: [{ starts_at: at(anchor, '10:00'), ends_at: at(anchor, '12:00') }],
      });
      await db.registration.create({
        data: { activity_id: clash.id, student_id: studentRow2.id, status: 'accepted' },
      });
      const shared = browser(base);
      await shared.signIn('0000000004', '000004', 't1' + randomUUID());
      const mine = await timeline(shared, 'scope=mine&' + window);
      const item = mine.data.items.find((row) => row.activity_code === 'TL-0001');
      assert.equal(item.has_planned_overlap, true);
      assert.equal(
        item.segments.find((segment) => segment.starts_at === at(anchor, '09:30')).has_planned_overlap,
        true,
      );
      assert.equal(
        item.segments.find((segment) => segment.starts_at === at(before, '09:15')).has_planned_overlap,
        false,
      );
      const publicItem = (await publicQuery())
        .data.items.find((row) => row.activity_code === 'TL-0001');
      assert.equal(publicItem.has_planned_overlap, undefined);
      assert.ok(publicItem.segments.every((segment) => segment.has_planned_overlap === undefined));

      // 取消活动作为当前活动：自身分段与汇总都不提示重叠。
      await db.registration.create({
        data: { activity_id: cancelled.id, student_id: studentRow2.id, status: 'accepted' },
      });
      const withCancelled = await timeline(shared, 'scope=mine&' + window);
      const cancelledItem = withCancelled.data.items.find(
        (row) => row.activity_code === 'TL-0007',
      );
      assert.equal(cancelledItem.status, 'cancelled');
      assert.equal(cancelledItem.has_planned_overlap, false);
      assert.ok(cancelledItem.segments.every((segment) => segment.has_planned_overlap === false));
      // 取消活动作为比较对象：仍不影响本人其他活动的重叠提示。
      const still = withCancelled.data.items.find((row) => row.activity_code === 'TL-0001');
      assert.equal(still.has_planned_overlap, true);
      assert.equal(
        still.segments.find((segment) => segment.starts_at === at(anchor, '14:15'))
          .has_planned_overlap,
        false,
      );
    });

    await t.test('周规则排除日与补充时段按北京时间返回并保留毫秒', async (t) => {
      const weekly = await create('TL-0008', '周常规演示', {
        schedule_type: 'weekly',
        duration_start_date: '2026-12-07',
        duration_end_date: '2026-12-20',
        weekly_slots: [{ weekday: 1, start_time: '09:00', end_time: '11:30', end_day_offset: 0 }],
        excluded_dates: ['2026-12-14'],
        additional_slots: [
          { starts_at: '2026-12-16T05:00:00.100Z', ends_at: '2026-12-16T05:00:00.900Z' },
        ],
      });
      t.after(() => db.activity.delete({ where: { id: weekly.id } }));
      const params = new URLSearchParams({
        scope: 'public', q: weekly.activity_code,
        from: '2026-12-01T00:00:00+08:00', to: '2026-12-31T00:00:00+08:00',
      });
      const response = await timeline(student, params);
      assert.equal(response.status, 200);
      const [item] = response.data.items;
      assert.equal(item.schedule_type, 'weekly');
      assert.deepEqual(
        item.segments.map((segment) => [segment.starts_at, segment.ends_at]),
        [
          ['2026-12-07T09:00:00+08:00', '2026-12-07T11:30:00+08:00'],
          ['2026-12-16T13:00:00.100+08:00', '2026-12-16T13:00:00.900+08:00'],
        ],
      );
    });

    await t.test('审核状态枚举和带时区时刻不合法时返回 422 并指出字段', async () => {
      const typo = await timeline(teacher, 'scope=all&' + window + '&review_status=typo');
      assert.equal(typo.status, 422);
      assert.equal(typo.details[0].field, 'review_status');
      for (const [field, value] of [
        ['from', undefined], ['to', undefined], ['from', '2026-11-18'],
        ['to', '2026-11-25T00:00:00'], ['from', '2026-11-18T00:00Z'],
        ['from', '2026-02-30T01:00:00Z'], ['to', '2026-13-02T01:00:00Z'],
      ]) {
        const params = new URLSearchParams({ scope: 'public', from: iso(from), to: iso(to) });
        if (value === undefined) params.delete(field);
        else params.set(field, value);
        const response = await timeline(student, params);
        assert.equal(response.status, 422, params.toString());
        assert.equal(response.details[0].field, field);
      }
      // 带时区的偏移格式被接受。
      const offset = await timeline(
        student,
        'scope=public&from=' + encodeURIComponent('2026-11-19T00:00:00+08:00') +
          '&to=' + encodeURIComponent('2026-11-26T00:00:00+08:00'),
      );
      assert.equal(offset.status, 200);
    });

    await t.test('负责人候选按授权范围独立于分页、窗口和筛选', async () => {
      const other = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
      const firstPage = await timeline(teacher, 'scope=all&' + window + '&page_size=1');
      assert.equal(firstPage.data.items.length, 1);
      const ids = firstPage.data.owner_options.map((option) => option.account_id);
      assert.deepEqual(ids.slice().sort(), [ownerId, other.id].sort());
      assert.ok(
        firstPage.data.owner_options.every(
          (option) => typeof option.display_name === 'string' && option.display_name.length > 0,
        ),
      );
      // 换一页、换窗口或加筛选，候选都不变。
      const secondPage = await timeline(teacher, 'scope=all&' + window + '&page_size=1&page=2');
      assert.deepEqual(secondPage.data.owner_options, firstPage.data.owner_options);
      const far = await timeline(
        teacher,
        'scope=all&from=' + iso(now + 100 * day) +
          '&to=' + iso(now + 107 * day),
      );
      assert.equal(far.data.items.length, 0);
      assert.deepEqual(far.data.owner_options, firstPage.data.owner_options);
      const filtered = await timeline(teacher, 'scope=all&' + window + '&owner_account_id=' + other.id);
      assert.deepEqual(filtered.data.owner_options, firstPage.data.owner_options);
      // 负责人范围只含本人，公开范围不返回候选。
      const managed = await timeline(owner, 'scope=managed&' + window);
      assert.deepEqual(
        managed.data.owner_options.map((option) => option.account_id),
        [ownerId],
      );
      const publicPage = await publicQuery();
      assert.equal(publicPage.data.owner_options, undefined);
    });
  } finally {
    await app?.close();
  }
});
