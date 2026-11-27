import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { atTime, createScheduleDataset, createScheduleDemo, createWeeklyRevisionPair, moveActivityTo, presetRegistration, setActivityOwner } from './timeline-fixture.mjs';

import { withPages, shiftDay, link, button, visible, publicSchedulePage, holdResponse, settleRender } from './page-environment.mjs';

test('日程范围、一致性与权限', { timeout: 10 * 60_000 }, async t => {
  await withPages(t, async ({ web, admin, api, student, owner, helper, teacher, db, first }) => {
    const demo = await createScheduleDemo(db);
    await t.test('打开和关闭日程详情时保留当前列表和键盘焦点', async t => {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const prefix = 'TL-DETAIL-';
      await createScheduleDataset(db, { codePrefix:prefix, titlePrefix:'日程打开详情', date:today, count:1 });
      t.after(() => db.activity.deleteMany({where:{activity_code:{startsWith:prefix}}}));
      await helper.setViewportSize({width:1440,height:900});
      await helper.goto(web + '/schedule?view=list');
      const row = helper.locator('.schedule-list li').filter({hasText:'日程打开详情'});
      await visible(row);
      assert.equal(new URL(helper.url()).searchParams.has('date'), false);
      const requests = [];
      const record = req => { if (new URL(req.url()).pathname === '/api/v1/timeline') requests.push(req.url()); };
      helper.on('request', record);
      t.after(() => helper.off('request', record));
      const initial = await row.elementHandle();
      await row.getByRole('button').first().click();
      await visible(helper.getByRole('complementary',{name:'日程详情'}));
      await button(helper,'返回日程').click();
      await settleRender(helper);
      assert.ok(await initial.evaluate(el => el.isConnected && el.contains(document.activeElement)));
      assert.deepEqual(requests, []);
    });

    await t.test('日程 1-1 审核改期后返回原日程保留条件并重读', async (t) => {
      const date = demo.anchor;
      const title = '改期审核';
      const submitter = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
      const pair = await createWeeklyRevisionPair(db, {
        activityCode: 'TL-9401',
        title,
        date,
        ownerUsername: '0000000003',
      });
      await presetRegistration(db, { activityCode: 'TL-9401', studentNo: '0000000001', status: 'accepted' });
      t.after(async () => {
        await db.registration.deleteMany({
          where: { activity: { activity_code: { in: ['TL-9401'] } } },
        });
        await db.activityReview.deleteMany({
          where: { activity: { activity_code: { in: ['TL-9401'] } } },
        });
        await db.activity.deleteMany({ where: { activity_code: { in: ['TL-9401'] } } });
      });

      await teacher.setViewportSize({ width: 1440, height: 900 });
      const scheduleAt = (revision) =>
        admin +
        '/schedule?date=' +
        date +
        '&unit=week&view=list&revision=' +
        revision +
        '&q=' +
        encodeURIComponent(title);
      const detail = teacher.getByRole('complementary', { name: '日程详情' });
      const row = teacher.locator('.schedule-list li').filter({ hasText: title });
      const mineAt =
        web + '/mine/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title);
      const mineRow = student.locator('.schedule-list li').filter({ hasText: title });

      const changedDates = date + ' 至 ' + pair.pending.duration_end_date;
      await teacher.goto(scheduleAt('published'));
      await visible(row);
      assert.equal(await row.locator('.service-period').innerText(), date);
      await teacher.goto(scheduleAt('working'));
      await visible(row);
      assert.equal(await row.locator('.service-period').innerText(), changedDates);
      assert.match(await row.locator('.meta-line').innerText(), /待审核/);

      // 驳回后保留选中活动，日程恢复为获批版本的日期。
      await row.getByRole('button').first().click();
      await visible(detail.getByRole('heading', { name: title }));
      assert.equal(new URL(teacher.url()).searchParams.get('item'), pair.activity.id);
      const beforeReject = new URL(teacher.url());
      await link(teacher, '查看待审版本').click();
      await visible(button(teacher, '驳回'));
      await teacher.getByLabel('审核意见（驳回必填）').fill('按原安排执行');
      await button(teacher, '驳回').click();
      await teacher.waitForURL((url) => url.pathname === '/schedule');
      await visible(teacher.getByText('已驳回', { exact: true }));
      await visible(detail.getByText(date, {exact:true}));
      assert.equal(new URL(teacher.url()).searchParams.get('item'), pair.activity.id);
      const afterReject = new URL(teacher.url());
      for (const key of ['date', 'unit', 'view', 'revision', 'q'])
        assert.equal(afterReject.searchParams.get(key), beforeReject.searchParams.get(key));
      await visible(row);
      assert.equal(await row.locator('.service-period').innerText(), date);

      // 学生端仍见获批版 A。
      await student.goto(mineAt);
      await visible(mineRow);
      assert.equal(await mineRow.locator('.service-period').innerText(), date);

      // 批准：驳回后重新提交同一 B（rev 3），批准后学生端见 B。
      const submitted = (
        await db.activityRevision.findFirstOrThrow({
          where: { activity_id: pair.activity.id, revision: 1 },
        })
      ).content;
      await db.activityRevision.create({
        data: {
          activity_id: pair.activity.id,
          revision: 3,
          revision_state: 'pending_review',
          created_by: submitter.id,
          content: { ...submitted, schedule: pair.pending },
        },
      });
      await db.activity.update({ where: { id: pair.activity.id }, data: { working_revision: 3 } });
      await db.activityReview.create({
        data: {
          activity_id: pair.activity.id,
          revision: 3,
          previous_revision: 1,
          submitted_by: submitter.id,
        },
      });

      await teacher.goto(scheduleAt('working'));
      await visible(row);
      assert.equal(await row.locator('.service-period').innerText(), changedDates);
      assert.match(await row.locator('.meta-line').innerText(), /待审核/);
      await row.getByRole('button').first().click();
      await visible(detail.getByRole('heading', { name: title }));
      const beforeApprove = new URL(teacher.url());
      await link(teacher, '查看待审版本').click();
      await visible(button(teacher, '批准发布'));
      await button(teacher, '批准发布').click();
      await teacher.waitForURL((url) => url.pathname === '/schedule');
      await visible(teacher.getByText('已批准发布', { exact: true }));
      const afterApprove = new URL(teacher.url());
      for (const key of ['date', 'unit', 'view', 'revision', 'q'])
        assert.equal(afterApprove.searchParams.get(key), beforeApprove.searchParams.get(key));
      await visible(detail.getByText(changedDates, {exact:true}));
      assert.equal(afterApprove.searchParams.get('item'), beforeApprove.searchParams.get('item'));
      assert.doesNotMatch(await row.locator('.meta-line').innerText(), /待审核/);

      // 学生现在看到新获批的完整日期。
      await student.goto(mineAt);
      await visible(mineRow);
      assert.equal(await mineRow.locator('.service-period').innerText(), changedDates);

      // 只看待审核：处理完成后活动移出结果，页面给出空态。
      await teacher.goto(
        admin +
          '/schedule?date=' +
          date +
          '&unit=week&view=list&pending=1&q=' +
          encodeURIComponent(title),
      );
      await visible(teacher.getByText('该窗口和筛选条件下没有活动'));
      assert.equal(await teacher.locator('.schedule-list li').count(), 0);
    });

    await t.test('日程 1-2 报名与交接改变可见范围', async (t) => {
      const date = demo.anchor;
      const helperAccount = await db.account.findUniqueOrThrow({
        where: { username: '0000000004' },
      });
      const template = (
        await db.activityRevision.findFirstOrThrow({
          where: { activity_id: first.id, revision: 1 },
        })
      ).content;
      const create = (activity_code, title) =>
        db.activity.create({
          data: {
            activity_code,
            status: 'published',
            working_revision: 1,
            published_revision: 1,
            members: { create: { account_id: helperAccount.id, member_role: 'owner' } },
            revisions: {
              create: {
                revision: 1,
                revision_state: 'approved',
                approved_at: new Date(),
                created_by: helperAccount.id,
                content: {
                  ...template,
                  title,
                  schedule: {
                    schedule_type: 'continuous',
                    starts_at: atTime(date, '10:00'),
                    ends_at: atTime(date, '12:00'),
                  },
                },
              },
            },
          },
        });
      await create('TL-9411', '范围变化甲');
      await create('TL-9412', '交接演示甲');
      await create('TL-9413', '交接演示乙');
      t.after(async () => {
        await db.registration.deleteMany({
          where: { activity: { activity_code: { startsWith: 'TL-941' } } },
        });
        await db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-941' } } });
      });

      // 报名关系决定「我的日程」的可见范围：录取可见，退出消失，恢复再出现。
      await student.setViewportSize({ width: 1440, height: 900 });
      await presetRegistration(db, { activityCode: 'TL-9411', studentNo: '0000000001', status: 'accepted' });
      await student.goto(
        web + '/mine/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent('范围变化甲'),
      );
      const mineRow = student.locator('.schedule-list li').filter({ hasText: '范围变化甲' });
      await visible(mineRow);
      await presetRegistration(db, { activityCode: 'TL-9411', studentNo: '0000000001', status: 'exited' });
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(student.getByText('该窗口和筛选条件下没有活动'));
      assert.equal(await mineRow.count(), 0);
      await presetRegistration(db, { activityCode: 'TL-9411', studentNo: '0000000001', status: 'accepted' });
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(mineRow);

      // 负责人被移出单项活动：时间轴与列表一起移除，自己的其他活动保留。
      const managedAt = (view) =>
        web +
        '/managed-schedule?date=' +
        date +
        '&unit=week&view=' +
        view +
        '&q=' +
        encodeURIComponent('交接演示');
      await helper.goto(managedAt('chart'));
      const chartRows = helper.locator('.chart tbody tr');
      await visible(chartRows.first());
      assert.equal(await chartRows.count(), 2);
      await setActivityOwner(db, { activityCode: 'TL-9413', username: '0000000004', attached: false });
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      await chartRows.filter({ hasText: '交接演示乙' }).waitFor({ state: 'detached' });
      assert.equal(await chartRows.count(), 1);

      // 列表里正选着的活动被移出：详情一起关闭，只留下仍然可见的活动。
      await helper.goto(managedAt('list'));
      const managedRows = helper.locator('.schedule-list li');
      await visible(managedRows.first());
      assert.equal(await managedRows.count(), 1);
      await managedRows.first().getByRole('button').first().click();
      const detail = helper.getByRole('complementary', { name: '日程详情' });
      await visible(detail.getByRole('heading', { name: '交接演示甲' }));
      await setActivityOwner(db, { activityCode: 'TL-9412', username: '0000000004', attached: false });
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(helper.getByText('所选活动已移出当前日期或筛选范围'));
      assert.equal(await managedRows.count(), 0);
      assert.equal(await helper.locator('.schedule-detail').count(), 0);
    });

    await t.test('日程 1-3 分页期间数据变化后重校准', async (t) => {
      const date = shiftDay(demo.paged, 7);
      const title = '重校准演示';
      await createScheduleDataset(db, {
        codePrefix: 'TL-96',
        titlePrefix: title,
        date,
        count: 41,
      });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-96' } } }));
      const template = (
        await db.activityRevision.findFirstOrThrow({
          where: { activity_id: first.id, revision: 1 },
        })
      ).content;
      await student.setViewportSize({ width: 1440, height: 900 });
      const requested = [];
      const record = (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/timeline') requested.push(Number(url.searchParams.get('page')));
      };
      student.on('request', record);
      t.after(() => student.off('request', record));
      await student.goto(
        web + '/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title),
      );
      const rows = student.locator('.schedule-list li');
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));

      // 排序最靠前的活动移出窗口：已加载页的 total 与新页不一致，只有整段重读能校准。
      const moved = await db.activity.findUniqueOrThrow({ where: { activity_code: 'TL-9601' } });
      await db.activityRevision.update({
        where: { activity_id_revision: { activity_id: moved.id, revision: 1 } },
        data: {
          content: {
            ...template,
            title: title + ' 01',
            schedule: {
              schedule_type: 'continuous',
              starts_at: atTime(shiftDay(date, 7), '10:00'),
              ends_at: atTime(shiftDay(date, 7), '12:00'),
            },
          },
        },
      });
      requested.length = 0;
      await student.locator('.schedule-more button').click();
      await visible(student.getByText(/^40 项/));
      // 第二页与已加载首页属于不同结果集。
      assert.deepEqual(requested, [2, 1, 2], '范围发生变化后整段重读');

      // 已加载范围与同条件服务端结果逐项一致，无重复无缺口。
      const server = await Promise.all([1, 2].map((n) => publicSchedulePage(student, date, title, n)));
      const expected = server.flatMap((page) => page.items.map((item) => item.title));
      const shown = await rows.evaluateAll((items) =>
        items.map((li) => li.querySelector('.row-button')?.textContent?.trim()),
      );
      assert.deepEqual(shown, expected);
      assert.equal(new Set(shown).size, shown.length);
      assert.equal(shown.includes(title + ' 01'), false);

      // 同一个已加载范围在时间轴视图上再核一次：行标题取自 tr > th 内 strong，逐项相等且无重复。
      await button(student, '时间轴').click();
      const chartRows = student.locator('.chart tbody tr');
      await visible(chartRows.first());
      assert.equal(await chartRows.count(), expected.length);
      const chartTitles = await student
        .locator('.chart tbody tr > th strong')
        .evaluateAll((items) => items.map((node) => node.textContent.trim()));
      assert.deepEqual(chartTitles, expected);
      assert.equal(new Set(chartTitles).size, chartTitles.length);
      await button(student, '列表').click();

      // 活动标识取自同一结果，刷新后范围仍完整、选中保留。
      await rows.first().getByRole('button').first().click();
      const detail = student.getByRole('complementary', { name: '日程详情' });
      await visible(detail.getByRole('heading', { name: expected[0] }));
      assert.equal(
        new URL(student.url()).searchParams.get('item'),
        server[0].items[0].activity_id,
      );
      requested.length = 0;
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(detail.getByRole('heading', { name: expected[0] }));
      assert.deepEqual([...requested].sort((a, b) => a - b), [1, 2], '刷新重读已加载的两页');

      // 调整当天服务时刻后，侧栏仍指向同一活动。
      await db.activityRevision.update({
        where: {
          activity_id_revision: { activity_id: server[0].items[0].activity_id, revision: 1 },
        },
        data: {
          content: {
            ...template,
            title: expected[0],
            schedule: {
              schedule_type: 'continuous',
              starts_at: atTime(date, '11:00'),
              ends_at: atTime(date, '12:00'),
            },
          },
        },
      });
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(detail.getByRole('heading', {name:expected[0]}));
      assert.equal(new URL(student.url()).searchParams.get('item'), server[0].items[0].activity_id);
      assert.equal(await rows.count(), 40);
      assert.ok((await rows.first().innerText()).includes(expected[0]));
    });

    await t.test('日程 1-4 深分页刷新请求上限', async (t) => {
      const date = shiftDay(demo.paged, 14);
      const title = '深页演示';
      const created = await createScheduleDataset(db, {
        codePrefix: 'TL-95',
        titlePrefix: title,
        date,
        count: 1001,
      });
      assert.equal(created.count, 1001);
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-95' } } }));

      await teacher.setViewportSize({ width: 1440, height: 900 });
      const query = 'date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title);
      const timeline = (url) =>
        url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === title;
      const last = await db.activity.findUniqueOrThrow({ where: { activity_code: created.codes.at(-1) } });
      await teacher.goto(admin + '/schedule?' + query + '&item=' + last.id);
      const detail = teacher.getByRole('complementary', { name: '日程详情' });
      await detail.getByRole('heading', { name: '深页演示 1001' }).waitFor({ timeout: 60000 });
      const expectedPages = Array.from({ length: 51 }, (_, i) => i + 1);

      const claimed = [];
      const live = new Set();
      let peak = 0;
      const threeHeld = Promise.withResolvers();
      let heldCount = 0;
      const track = (request) => {
        const url = new URL(request.url());
        if (!timeline(url)) return;
        claimed.push(Number(url.searchParams.get('page')));
        live.add(request);
        peak = Math.max(peak, live.size);
      };
      const settle = (request) => live.delete(request);
      teacher.on('request', track);
      teacher.on('requestfinished', settle);
      teacher.on('requestfailed', settle);
      t.after(() => {
        teacher.off('request', track);
        teacher.off('requestfinished', settle);
        teacher.off('requestfailed', settle);
      });

      // 刷新只为已加载的 51 页取页：压住第 1 页直到另外两页也已发出，峰值 3 由闸门决定，不靠时序快慢。
      await teacher.route(
        timeline,
        async (route) => {
          const page = Number(new URL(route.request().url()).searchParams.get('page'));
          heldCount += 1;
          if (heldCount === 3) threeHeld.resolve();
          if (page === 1) await threeHeld.promise;
          await route.continue();
        },
        { times: 5 },
      );
      const refreshed = teacher.waitForResponse((response) => {
        const url = new URL(response.url());
        return timeline(url) && url.searchParams.get('page') === '51';
      });
      await teacher.evaluate(() => window.dispatchEvent(new Event('focus')));
      await refreshed;
      assert.deepEqual(claimed, expectedPages);
      await teacher.locator('.schedule-view[aria-busy=true]').waitFor({ state: 'hidden' });
      assert.equal(peak, 3);
      await visible(detail.getByRole('heading', { name: '深页演示 1001' }));

      // 切换条件后旧查询不再补页：压住旧查询的 3 个在途请求，切换后再放行。
      const held = [];
      const received = Promise.withResolvers();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      await teacher.route(
        timeline,
        async (route) => {
          held.push(Number(new URL(route.request().url()).searchParams.get('page')));
          if (held.length === 3) received.resolve();
          await gate;
          await route.continue();
        },
        { times: 5 },
      );
      await teacher.evaluate(() => window.dispatchEvent(new Event('focus')));
      await received.promise;
      assert.equal(held.length, 3);
      const search = teacher.getByRole('searchbox');
      await search.fill('没有这一类活动');
      const switched = teacher.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === '没有这一类活动';
      });
      await search.press('Enter');
      await teacher.waitForURL((url) => url.searchParams.get('q') === '没有这一类活动');
      await settleRender(teacher);
      try {
        await switched;
      } finally {
        release();
      }
      assert.deepEqual([...held].sort((a, b) => a - b), [1, 2, 3], '旧查询不再补页');

      // 条件切回后仍从第 1 页读起，后续加载可用。
      await teacher.goto(admin + '/schedule?' + query);
      await visible(teacher.getByText('1001 项（已显示 20）', { exact: false }));
      await teacher.locator('.schedule-more button').click();
      await visible(teacher.getByText('1001 项（已显示 40）', { exact: false }));
    });

    await t.test('日程 1-11 并发刷新中权限收回不被普通失败掩盖', async (t) => {
      const date = shiftDay(demo.paged, 28);
      const title = '并发失败演示';
      await createScheduleDataset(db, { codePrefix: 'TL-91', titlePrefix: title, date, count: 41 });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-91' } } }));
      await student.setViewportSize({ width: 1440, height: 900 });
      const timeline = (url) =>
        url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === title;
      const pageOnly = (page) => (url) => timeline(url) && url.searchParams.get('page') === page;
      const unavailable = (route) => route.fulfill({ status: 503, body: '' });
      const revoked = (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'forbidden',
            message: '当前身份无权执行此操作',
            request_id: randomUUID(),
          }),
        });
      const at = web + '/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title);
      const loadTwoPages = async () => {
        await student.locator('.schedule-more button').click();
        await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      };

      await student.goto(at);
      const rows = student.locator('.schedule-list li');
      const detail = student.getByRole('complementary', { name: '日程详情' });
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));
      await loadTwoPages();
      await rows.first().getByRole('button').first().click();
      await visible(detail.getByRole('heading', { name: title + ' 01' }));

      // 第 2 页的权限收回不被第 1 页的普通失败掩盖：清空页集合与详情，入口回到「重新读取」。
      await student.route(pageOnly('1'), unavailable, { times: 1 });
      await student.route(pageOnly('2'), revoked, { times: 1 });
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(student.getByText(/无权查看该日程范围/));
      assert.equal(await rows.count(), 0);
      assert.equal(await student.locator('.schedule-detail').count(), 0);
      await visible(button(student, '重新读取'));

    });

    await t.test('日程 1-12 总数与首页不变时替换中间页活动', async (t) => {
      const date = shiftDay(demo.paged, 35);
      const title = '替换演示';
      await createScheduleDataset(db, { codePrefix: 'TL-970', titlePrefix: title, date, count: 41 });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-97' } } }));
      await student.goto(web + '/schedule?' + new URLSearchParams({ date, unit: 'week', view: 'list', q: title }));
      const more = student.locator('.schedule-more button');
      await more.click();
      await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      await moveActivityTo(db, { activityCode: 'TL-97021', date: shiftDay(date, 7) });
      await createScheduleDataset(db, { codePrefix: 'TL-979', titlePrefix: title + ' 移入', date, count: 1 });
      await more.click();
      await more.waitFor({ state: 'detached' });
      const current = await Promise.all([1, 2, 3].map((n) => publicSchedulePage(student, date, title, n)));
      assert.equal(current[0].total, 41);
      const shown = await student.locator('.schedule-list .row-button').allTextContents();
      assert.deepEqual(shown.map((text) => text.trim()), current.flatMap((page) => page.items.map((r) => r.title)));
    });

    await t.test('日程 1-13 范围收缩后补读不保留已移出活动', async (t) => {
      const date = shiftDay(demo.paged, 42);
      const title = '收缩演示';
      await createScheduleDataset(db, { codePrefix: 'TL-98', titlePrefix: title, date, count: 41 });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-98' } } }));
      await student.setViewportSize({ width: 1440, height: 900 });
      await student.goto(
        web + '/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title),
      );
      const rows = student.locator('.schedule-list li');
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));
      assert.equal(await rows.count(), 20);

      // 删掉最靠前的 21 项：范围收缩为 20 项，「加载更多」读到空页。
      await db.activity.deleteMany({
        where: { activity_code: { startsWith: 'TL-98', lt: 'TL-9822' } },
      });
      await student.locator('.schedule-more button').click();
      await student.locator('.schedule-more').waitFor({ state: 'detached' });
      await visible(student.getByText(/^20 项/));
      assert.equal(await rows.count(), 20, '旧页集合不被当成功提交');
      assert.equal(await rows.filter({ hasText: title + ' 01' }).count(), 0, '被删的活动不出现');
      assert.equal(await rows.filter({ hasText: title + ' 22' }).count(), 1, '新结果仍完整');
      assert.equal(await rows.filter({ hasText: title + ' 41' }).count(), 1);

      // 补读路径同此：删掉的项在首屏之后，且收缩发生在首屏之后，旧第 1 页也不得被当成功提交。
      const shrink = shiftDay(demo.paged, 43);
      const shrinkTitle = '补读收缩';
      await createScheduleDataset(db, {
        codePrefix: 'TL-88',
        titlePrefix: shrinkTitle,
        date: shrink,
        count: 41,
      });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-88' } } }));
      const shrinkAt =
        web + '/schedule?date=' + shrink + '&unit=week&view=list&q=' + encodeURIComponent(shrinkTitle);
      const [target] = (await publicSchedulePage(student, shrink, shrinkTitle, 3)).items;
      // 首屏拿的是收缩前的快照，期间的删除让补读读到空页。
      const held = await holdResponse(
        student,
        (url) => url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === shrinkTitle,
      );
      await student.goto(shrinkAt + '&item=' + target.activity_id);
      await held.received;
      await db.activity.deleteMany({
        where: { activity_code: { startsWith: 'TL-88', lt: 'TL-8822' } },
      });
      await held.release();
      const shrinkDetail = student.getByRole('complementary', { name: '日程详情' });
      await visible(shrinkDetail.getByRole('heading', { name: shrinkTitle + ' 41' }));
      await visible(student.getByText(/^20 项/));
      assert.equal(await rows.count(), 20, '旧页集合不被当成功提交');
      assert.equal(await rows.filter({ hasText: shrinkTitle + ' 01' }).count(), 0, '被删的活动不出现');
      assert.equal(await rows.filter({ hasText: shrinkTitle + ' 41' }).count(), 1);
      assert.equal(await student.getByText('所选活动已移出当前日期或筛选范围').count(), 0);
    });

    await t.test('日程 1-15 刷新重试整段重读不拼接旧页', async (t) => {
      const date = shiftDay(demo.paged, 56);
      const title = '重试重读演示';
      const template = (
        await db.activityRevision.findFirstOrThrow({
          where: { activity_id: first.id, revision: 1 },
        })
      ).content;
      await createScheduleDataset(db, { codePrefix: 'TL-87', titlePrefix: title, date, count: 41 });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-87' } } }));
      const at = web + '/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title);
      const timeline = (url) =>
        url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === title;

      await student.setViewportSize({ width: 1440, height: 900 });
      await student.goto(at);
      const rows = student.locator('.schedule-list li');
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));
      await student.locator('.schedule-more button').click();
      await visible(student.getByText('41 项（已显示 40）', { exact: false }));

      // 第 1 页换成新标题、第 2 页这一轮失败：旧页集合原样保留。
      const changed = await db.activity.findUniqueOrThrow({ where: { activity_code: 'TL-8701' } });
      await db.activityRevision.update({
        where: { activity_id_revision: { activity_id: changed.id, revision: 1 } },
        data: {
          content: {
            ...template,
            title: title + ' 01 改',
            schedule: {
              schedule_type: 'continuous',
              starts_at: atTime(date, '10:00'),
              ends_at: atTime(date, '12:00'),
            },
          },
        },
      });
      const requested = [];
      const record = (request) => {
        const url = new URL(request.url());
        if (timeline(url)) requested.push(Number(url.searchParams.get('page')));
      };
      student.on('request', record);
      t.after(() => student.off('request', record));
      await student.route(
        (url) => timeline(url) && url.searchParams.get('page') === '2',
        (route) => route.fulfill({ status: 503, body: '' }),
        { times: 1 },
      );
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(student.getByText('状态待刷新，请重试', { exact: false }));
      assert.equal((await rows.first().innerText()).includes(title + ' 01 改'), false);

      // 重试从第 1 页整段重读到已加载末页，不拼接上一次显示的页。
      requested.length = 0;
      await button(student, '重试').click();
      await visible(rows.filter({ hasText: title + ' 01 改' }));
      assert.deepEqual(requested, [1, 2], '重试从第 1 页起整段重读已加载页');
      assert.match(await rows.first().innerText(), new RegExp(title + ' 01 改'));
      assert.equal(await rows.count(), 40);
    });

    await t.test('日程 1-16 跨午夜活动位于首屏之后时补读不提前退出', async (t) => {
      const date = shiftDay(demo.paged, 63);
      const before = shiftDay(date, -1);
      const title = '深页跨午夜';
      await createScheduleDataset(db, {
        codePrefix: 'TL-99',
        titlePrefix: title,
        date,
        count: 20,
        extra: [
          {
            code: 'TL-9921',
            title: title + ' 跨夜',
            schedule: {
              schedule_type: 'custom',
              duration_start_date: before,
              duration_end_date: date,
              slots: [{ starts_at: atTime(before, '23:00'), ends_at: atTime(date, '02:00') }],
            },
          },
        ],
      });
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-99' } } }));
      await student.setViewportSize({ width: 1440, height: 900 });
      const at = web + '/schedule?date=' + date + '&unit=week&view=list&q=' + encodeURIComponent(title);

      // 跨午夜项按编码排在第 21 位，落在首屏之后。
      await student.goto(at);
      await visible(student.getByText('21 项（已显示 20）', { exact: false }));
      const [target] = (await publicSchedulePage(student, date, title, 2)).items;

      // 带选中直接进入：首屏读第 1 页后自动补读第 2 页，选中在跨午夜段上成立。
      await student.goto(at + '&item=' + target.activity_id);
      const rows = student.locator('.schedule-list li');
      const detail = student.getByRole('complementary', { name: '日程详情' });
      await visible(detail.getByRole('heading', { name: title + ' 跨夜' }));
      await visible(detail.getByText(before + ' 至 ' + date, {exact:true}));
      assert.equal(await student.getByText('所选活动已移出当前日期或筛选范围').count(), 0);
      await visible(rows.filter({ hasText: title + ' 跨夜' }));
      assert.equal(await rows.count(), 21, '补读未因开始时刻早于窗口首而提前退出');
      assert.equal(new URL(student.url()).searchParams.get('item'), target.activity_id);
      assert.equal(new URL(student.url()).searchParams.has('slot'), false);

      // 时间轴同样有这一段。
      await button(student, '时间轴').click();
      await visible(
        student.getByRole('button', { name: title + ' 跨夜 ' + before + ' 至 ' + date }),
      );
      await student.setViewportSize({ width: 390, height: 844 });
      await button(student, '返回日程').click();
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await visible(button(student, '查看活动'));
      assert.equal(new URL(student.url()).searchParams.has('slot'), false);
      await student.setViewportSize({ width: 1440, height: 900 });
    });
    await t.test('日程响应缺少范围摘要时可从当前窗口重试', async () => {
      const path = web + '/schedule?date=' + demo.anchor + '&unit=week&view=list';
      await student.route('**/api/v1/timeline?*', async route => {
        const response = await route.fetch();
        const headers = { ...response.headers() };
        delete headers['x-timeline-range'];
        await route.fulfill({ status: response.status(), headers, body: await response.body() });
      }, { times: 1 });
      await student.goto(path);
      const alert = student.getByRole('alert').filter({ hasText: '日程响应缺少范围摘要' });
      await visible(alert);
      await button(alert, '重新读取').click();
      await visible(student.locator('.schedule-list li').first());
      assert.equal(await alert.count(), 0);
    });
  });
});
