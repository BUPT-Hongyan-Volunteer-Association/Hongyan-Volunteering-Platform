import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { launchBrowser } from '../scripts/browser.mjs';
import { preview } from 'vite';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';
import { checkHourPages } from './hour-pages-fixture.mjs';

const link = (page, name) => page.getByRole('link', { name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const visible = (locator) => locator.first().waitFor({ state: 'visible' });

async function openOptions(page, label) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  const trigger = page
    .locator('.platform-select')
    .filter({ has: input })
    .locator('.el-select__wrapper');
  await trigger.click();
  const list = page.locator('#' + (await input.getAttribute('aria-controls')));
  await list.waitFor({ state: 'visible' });
  return { trigger, list };
}
async function pickOption(page, label, option) {
  const { list } = await openOptions(page, label);
  await list.getByRole('option', { name: option, exact: true }).click();
  await list.waitFor({ state: 'hidden' });
}

async function signIn(browser, origin, username, password, width) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await page.getByLabel('账号', { exact: true }).fill(username);
  const student = username.startsWith('000');
  await page.getByLabel('当前密码').fill(student ? username.slice(-6) : password);
  await button(page, '登录').click();
  if (student) {
    await page.getByLabel('新密码').fill(password);
    await page.getByLabel('当前密码').fill(username.slice(-6));
    await button(page, '保存新密码').click();
  }
  await visible(button(page, '退出登录'));
  return page;
}

// Hold one real API response until the newer route has finished rendering.
async function holdResponse(page, pattern) {
  const received = Promise.withResolvers(),
    release = Promise.withResolvers(),
    delivered = Promise.withResolvers();
  await page.route(
    pattern,
    async (route) => {
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
      delivered.resolve();
    },
    { times: 1 },
  );
  return {
    received: received.promise,
    release: async () => {
      release.resolve();
      await delivered.promise;
    },
  };
}
async function settleRender(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function capture(page, name) {
  if (process.env.UI_CAPTURE_DIR) {
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: resolve(process.env.UI_CAPTURE_DIR, name + '.png') });
  }
}

async function fits(page) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    page.url(),
  );
}

test('三端页面、真实发布与报名录取流程', { timeout: 180000 }, async (t) => {
  const password = 'T1' + randomUUID();
  const adminPassword = 'A2' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: password, DEMO_ADMIN_PASSWORD: adminPassword });
  const servers = [];
  let api, browser;
  try {
    api = await createApp();
    await api.listen(0, '127.0.0.1');
    const apiOrigin = await api.getUrl();
    // All engines receive Secure session cookies over HTTPS, including on loopback.
    process.env.HY_LOCAL_HTTPS = '1';
    for (const app of ['web', 'admin']) {
      const root = resolve('..', app);
      const server = await preview({
        root,
        configFile: resolve(root, 'vite.config.ts'),
        preview: {
          port: 0,
          strictPort: false,
          host: '127.0.0.1',
          proxy: { '/api/v1': apiOrigin },
        },
      });
      servers.push(server);
    }
    const [web, admin] = servers.map((s) => 'https://127.0.0.1:' + s.httpServer.address().port);
    browser = await launchBrowser({ headless: true });
    const student = await signIn(browser, web, '0000000001', password, 390);
    const owner = await signIn(browser, web, '0000000002', password, 390);
    const teacher = await signIn(browser, admin, 'demo.teacher', password, 1440);
    const tech = await signIn(browser, admin, 'demo.admin', adminPassword, 1440);
    const db = api.get(Database);
    const first = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });

    await t.test('两种宽度从首页抵达个人页、活动工作区、后台和日程', async () => {
      for (const width of [390, 1440]) {
        for (const p of [student, owner, teacher]) await p.setViewportSize({ width, height: 900 });
        await student.goto(web);
        for (const name of ['我的报名', '通知', '我的']) {
          await link(student, name).click();
          await visible(student.getByRole('heading', { name, exact: true }));
          await fits(student);
        }
        await link(student, '我的时长').click();
        await student.locator('.entry-list a').first().click();
        await visible(student.getByText('2026-11-14'));
        await fits(student);
        await link(student, '返回我的').click();
        await link(student, '本人记录与反馈').click();
        await student.locator('.entry-list a').first().click();
        await visible(student.getByText('处罚', { exact: true }));
        await fits(student);
        await link(student, '返回我的').click();
        await link(student, '我的日程').click();
        await visible(student.getByText('该窗口和筛选条件下没有活动'));
        await link(student, '活动').click();
        await link(student, '活动日程（示例）').click();
        await visible(student.locator(width === 390 ? '.schedule-list' : '.chart-scroll'));
        await fits(student);
        assert.equal(await student.getByRole('navigation', { name: '活动管理' }).count(), 0);
        assert.equal(await link(student, '管理').count(), 0);
        await owner.goto(web);
        const studentMenu = owner.getByRole('navigation', { name: '学生导航' });
        const management = owner.getByRole('navigation', { name: '活动管理' });
        if (width === 390) {
          await studentMenu.getByRole('link', { name: '管理', exact: true }).click();
        } else {
          await visible(management);
          const top = await studentMenu.boundingBox(),
            bottom = await management.boundingBox();
          assert.ok(top.y + top.height <= bottom.y);
          assert.equal(
            await management.evaluate((el) => getComputedStyle(el).borderTopWidth),
            '1px',
          );
          for (const [name, path] of [
            ['新建活动', '/managed/new'],
            ['管理日程', '/managed-schedule'],
            ['我的管理活动', '/managed'],
          ]) {
            const entry = management.getByRole('link', { name, exact: true });
            await entry.click();
            await owner.waitForURL((u) => u.pathname === path);
            assert.equal(await entry.getAttribute('aria-current'), 'page');
            assert.equal(await management.locator('a.current').count(), 1);
            assert.equal(await studentMenu.getByRole('link').count(), 4);
          }
        }
        await link(owner, '校园服务甲').click();
        for (const tab of [
          '退出与恢复',
          '通知与回执',
          '现场人员记录',
          '时长批次',
          '漏记反馈',
          '错账修复组',
          '异常上报',
        ]) {
          if (!(await link(owner, tab).isVisible()))
            await owner.getByText('更多', { exact: true }).click();
          await link(owner, tab).click();
          if (tab === '时长批次') {
            await visible(owner.getByText('本活动还没有上传批次。'));
            assert.ok(await button(owner, '上传并预览').isDisabled());
            await fits(owner);
            continue;
          }
          await owner.locator('.entry-list a').first().click();
          await visible(owner.locator('article dl'));
          await fits(owner);
          await link(owner, '返回' + tab).click();
        }
        await teacher.goto(admin);
        await visible(teacher.getByText('待审 1 项'));
        if (await button(teacher, '展开导航').isVisible())
          await button(teacher, '展开导航').click();
        const nav = teacher.getByRole('navigation', { name: '后台导航' });
        for (const section of [
          '错账修复组',
          '异常复核',
          '申诉与更正',
          '学生档案',
          '建档导入',
          '账号与角色',
          '通知失败队列',
          '审计记录',
        ]) {
          await nav.getByRole('link', { name: section, exact: true }).click();
          await teacher.locator('main .entry-list a').first().click();
          await visible(teacher.locator('article dl'));
          await fits(teacher);
          await link(teacher, '返回' + section).click();
        }
        await link(teacher, '全院日程').click();
        await visible(teacher.locator(width === 390 ? '.schedule-list' : '.chart-scroll'));
        await fits(teacher);
      }
    });

    await t.test('时间轴保留筛选、分钟比例和当前线，并按角色定位时段', async () => {
      await student.goto(web + '/schedule');
      const row = student.locator('.chart tbody tr').filter({ hasText: '校园服务甲' });
      await visible(row);
      assert.equal(await row.locator('rect').count(), 3);
      const widths = await row
        .locator('rect')
        .evaluateAll((segments) => segments.map((s) => Number(s.getAttribute('width'))));
      assert.ok(Math.abs(widths[0] / widths[1] - 135 / 75) < 0.001);
      assert.ok((await student.locator('.now-line').count()) > 0);
      await student.getByLabel('进行中').check();
      await button(student, '列表').click();
      assert.equal(await student.locator('.schedule-list li').count(), 1);
      await button(student, '校园服务甲').click();
      await button(student, '时间轴').click();
      await visible(student.getByRole('complementary', { name: '时段详情' }));
      assert.ok(await student.getByLabel('进行中').isChecked());
      await student.keyboard.press('Escape');
      await student.setViewportSize({ width: 390, height: 900 });
      await student.goto(web + '/schedule');
      await button(student, '时间轴').click();
      await student.getByRole('button', { name: /^查看日期/ }).click();
      await student.getByRole('button', { name: '选择 2026-11-21', exact: true }).click();
      const bar = student.getByRole('button', { name: /校园服务甲.*09:30/ });
      await visible(bar);
      assert.equal(await student.locator('.now-line').count(), 0);
      await bar.focus();
      await student.keyboard.press('Enter');
      await visible(student.getByText(/09:30 至 .*10:45/));
      await student.reload();
      await visible(student.getByRole('heading', { name: '校园服务甲' }));
      await button(student, '返回日程').click();
      await fits(student);
    });

    await t.test('学生与老师能打开同一条待受理的异常申诉', async () => {
      await student.goto(web + '/mine/feedback');
      await student.getByRole('link', { name: /异常申诉/ }).click();
      await visible(student.getByText('A2026-014', { exact: true }));
      await visible(student.getByText('已提交，等待老师核查'));
      await teacher.goto(admin + '/manage/appeals');
      await teacher.getByRole('link', { name: /A2026-014/ }).click();
      await visible(teacher.getByText('待受理', { exact: true }));
      await visible(teacher.getByText('本人已提前联系负责人，请复核签到说明。'));
    });

    await t.test('三端同一活动的公开地点仅在批准后由 A 变为 B', async () => {
      await student.goto(web);
      await link(student, '校园服务甲').click();
      const location = student.locator('dd').filter({ hasText: '沙河 · 活动室' });
      await visible(location);
      assert.equal(await location.innerText(), '沙河 · 活动室 A');
      await owner.goto(web + '/managed/' + first.id + '/edit');
      await owner.getByLabel('活动地点', { exact: true }).fill('活动室 B');
      await button(owner, '保存草稿').click();
      await visible(owner.getByText('草稿已保存', { exact: true }));
      await button(owner, '提交审核').click();
      await visible(owner.getByText('已送审，内容已冻结'));
      await student.reload();
      await visible(location);
      assert.equal(await location.innerText(), '沙河 · 活动室 A');
      await teacher.goto(admin + '/schedule');
      await teacher.getByLabel('待审核', { exact: true }).check();
      await button(teacher, '校园服务甲').click();
      await link(teacher, '查看待审版本').click();
      await visible(teacher.getByRole('heading', { name: '逐字段差异' }));
      await visible(teacher.getByText(/活动室 A → 活动室 B/));
      await button(teacher, '批准发布').click();
      await visible(teacher.getByText('已批准发布', { exact: true }));
      await student.goto(web);
      await visible(student.getByText(/· 活动室 B/));
      await link(student, '校园服务甲').click();
      await visible(location);
      assert.equal(await location.innerText(), '沙河 · 活动室 B');
    });

    // Persist the roster fixture in this disposable DB. The browser uses the normal API.
    const fixtureStatuses = [
      ...Array(9).fill('submitted'), ...Array(17).fill('accepted'),
      ...Array(6).fill('waitlisted'), 'rejected', 'rejected', 'withdrawn',
    ];
    for (const [index, status] of fixtureStatuses.entries()) {
      const username = String(1000 + index).padStart(10, '0');
      await db.account.create({ data: {
        username, display_name: '名单测试' + (index + 1), password_hash: 'fixture',
        student: { create: { student_no: username, registrations: { create: {
          activity_id: first.id, status, submitted_at: new Date(Date.UTC(2026, 10, 10, index)),
        } } } },
      } });
    }
    await t.test('名单批量预览、回执和账号示例不会发送业务写请求', async () => {
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      await student.goto(web);
      for (const p of [student, owner, tech]) p.on('request', collect);
      await link(student, '通知').click();
      await student.getByRole('link', { name: /集合地点调整/ }).click();
      await button(student, '预览确认回执').click();
      await visible(student.getByText(/正式提交待接入/));
      await owner.goto(web + '/managed/' + first.id + '/roster');
      await owner.getByLabel('选择本页').check();
      await visible(owner.getByText(/已选 5 人/));
      await teacher.goto(admin + '/manage/accounts/staff-002');
      await visible(teacher.getByText('未找到该示例记录。'));
      await tech.goto(admin + '/manage/accounts/staff-002');
      await pickOption(tech, '操作', '停用独立后台账号');
      await button(tech, '预览操作').click();
      await visible(tech.getByText(/停用独立后台账号尚未提交/));
      assert.deepEqual(writes, []);
      for (const p of [student, owner, tech]) p.off('request', collect);
    });

    await t.test('编辑中恢复焦点和网络后保留输入，后台核验失败时暂停保存', async () => {
      await owner.goto(web + '/managed/' + first.id + '/edit');
      const title = owner.getByLabel('活动标题', { exact: true });
      await title.fill('尚未保存的标题');
      const focus = () => owner.evaluate(() => window.dispatchEvent(new Event('focus')));
      const verified = owner.waitForResponse((r) =>
        r.url().endsWith('/organizer/activities/' + first.id),
      );
      await focus();
      await verified;
      assert.equal(await title.inputValue(), '尚未保存的标题');
      // Fail the revalidation request even in engines that keep loopback reachable offline.
      const membership = '**/organizer/activities/' + first.id + '/members';
      await owner.route(membership, (route) => route.abort('internetdisconnected'));
      try {
        await focus();
        await visible(owner.getByRole('alert'));
        assert.equal(await title.inputValue(), '尚未保存的标题');
        assert.equal(await button(owner, '保存草稿').isEnabled(), false);
      } finally {
        await owner.unroute(membership);
      }
      await button(owner, '重试').click();
      await visible(owner.getByRole('button', { name: '保存草稿', disabled: false }));
      assert.equal(await title.inputValue(), '尚未保存的标题');
    });

    await t.test('管理活动的第二页及三种子页面保留来源', async () => {
      const account = await db.account.findUniqueOrThrow({ where: { username: '0000000002' } });
      const revision = await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id },
      });
      await owner.goto(web + '/managed');
      await visible(link(owner, '校园服务甲'));
      assert.equal(await button(owner, '下一页').count(), 0);
      for (let i = 1; i <= 20; i++) {
        await db.activity.create({
          data: {
            activity_code: 'TEST-' + String(i).padStart(2, '0'),
            status: 'draft',
            working_revision: 1,
            members: { create: { account_id: account.id, member_role: 'owner' } },
            revisions: {
              create: {
                revision: 1,
                revision_state: 'draft',
                created_by: account.id,
                content: { ...revision.content, title: '分页样例' + i },
              },
            },
          },
        });
      }
      await owner.reload();
      await visible(button(owner, '下一页'));
      assert.equal(await owner.locator('main li').count(), 20);
      await button(owner, '下一页').click();
      await visible(link(owner, '分页样例20'));
      assert.equal(await owner.locator('main li').count(), 1);
      const slow = await holdResponse(
        owner,
        (url) =>
          url.pathname.endsWith('/organizer/activities') && url.searchParams.get('page') === '1',
      );
      await button(owner, '上一页').click();
      try {
        await slow.received;
        await owner.goBack();
        await visible(link(owner, '分页样例20'));
      } finally {
        await slow.release();
      }
      await settleRender(owner);
      assert.equal(await owner.locator('main li').count(), 1);
      for (const entry of ['分页样例20', '编辑与送审', '报名名单']) {
        await link(owner, entry).click();
        await visible(link(owner, '返回我的管理活动'));
        await owner.goBack();
        await visible(link(owner, '分页样例20'));
        await link(owner, entry).click();
        await link(owner, '返回我的管理活动').click();
        await visible(link(owner, '分页样例20'));
        assert.equal(new URL(owner.url()).searchParams.get('page'), '2');
      }
    });

    await t.test('手机和桌面的失效时段链接保留筛选并关闭详情', async () => {
      for (const width of [390, 1440]) {
        await student.setViewportSize({ width, height: 900 });
        await student.goto(web + '/schedule?unit=hour&view=chart&date=2026-11-21&status=published');
        const afternoon = student.getByRole('button', { name: /校园服务甲.*14:15/ });
        await afternoon.focus();
        await student.keyboard.press('Enter');
        await visible(student.getByRole('complementary', { name: '时段详情' }));
        const url = new URL(student.url());
        url.searchParams.set('date', '2026-11-18');
        await student.goto(url.href);
        await visible(student.getByText('所选时段已移出当前窗口', { exact: true }));
        await student.waitForURL((u) => !u.searchParams.has('slot') && !u.searchParams.has('item'));
        assert.equal(new URL(student.url()).searchParams.get('status'), 'published');
        assert.equal(await student.locator('.schedule-detail').count(), 0);
        await visible(student.getByRole('button', { name: /校园服务甲.*09:15/ }));
      }
    });

    await t.test('切换活动清空名单选择，回收成员后移除已显示内容', async () => {
      const helper = await signIn(browser, web, '0000000004', password, 390);
      const second = await db.activity.findUniqueOrThrow({
        where: { activity_code: 'P2026-0002' },
      });
      const account = await db.account.findUniqueOrThrow({ where: { username: '0000000004' } });
      await db.activityMember.create({
        data: { activity_id: second.id, account_id: account.id, member_role: 'collaborator' },
      });
      await helper.goto(web + '/managed/' + first.id);
      await visible(helper.getByRole('heading', { name: '校园服务甲', exact: true }));
      const delayed = await holdResponse(helper, '**/organizer/activities/' + first.id);
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      try {
        await delayed.received;
        await helper.evaluate((id) => {
          history.pushState(history.state, '', '/managed/' + id);
          window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        }, second.id);
        await visible(helper.getByRole('heading', { name: '校园服务乙', exact: true }));
      } finally {
        await delayed.release();
      }
      await settleRender(helper);
      assert.equal(await helper.locator('.section-heading h1').innerText(), '校园服务乙');
      await helper.goto(web + '/managed/' + first.id + '/roster');
      await helper.getByLabel('选择本页').check();
      await link(helper, '返回我的管理活动').click();
      await link(helper, '校园服务乙').click();
      await link(helper, '报名名单').click();
      await visible(helper.getByText(/已选 0 人/));
      await link(helper, '编辑与送审').click();
      await visible(helper.getByLabel('活动标题', { exact: true }));
      await db.activityMember.delete({
        where: { activity_id_account_id: { activity_id: second.id, account_id: account.id } },
      });
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(helper.getByRole('alert'));
      assert.equal(await helper.getByLabel('活动标题', { exact: true }).count(), 0);
      await student.goto(web + '/managed/' + first.id + '/roster');
      await visible(student.getByText('当前账号无活动管理权限。'));
      await student.goto(admin);
      await visible(student.getByText('当前账号无后台权限。'));
      await teacher.goto(web + '/mine/feedback');
      await visible(teacher.getByText('当前账号无学生个人页面权限。'));
    });

    await t.test('名单勾选与行底色一致，翻页保留并随筛选清空', async () => {
      await owner.setViewportSize({ width: 1440, height: 900 });
      await owner.goto(web + '/managed/' + first.id + '/roster');
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      owner.on('request', collect);
      try {
        await owner.getByLabel('选择名单测试1', { exact: true }).check();
        await owner.getByLabel('选择名单测试2', { exact: true }).check();
        assert.equal(await owner.locator('tbody tr.selected').count(), 2);
        assert.equal(await owner.locator('tbody tr').count(), 5);
        await visible(owner.getByText('已选 2 人', { exact: true }));
        await visible(owner.getByText('本页 5 人，共 9 人'));
        await button(owner, '下一页').click();
        await visible(owner.getByText('本页 4 人，共 9 人'));
        await button(owner, '上一页').click();
        await visible(owner.getByLabel('选择名单测试1', { exact: true }));
        assert.equal(await owner.locator('tbody tr.selected input:checked').count(), 2);
        await button(owner, '查看名单测试2').click();
        await visible(owner.getByRole('heading', { name: '名单测试2的报名记录' }));
        await button(owner, '收起记录').click();
        for (const label of ['录取所选（待接入）', '设为候补（待接入）', '导出名单（待接入）'])
          assert.ok(await button(owner, label).isDisabled());
        await capture(owner, 'roster');
        await button(owner, '已录取 18').click();
        await visible(owner.getByText('已选 0 人', { exact: true }));
        assert.equal(await owner.locator('tbody tr.selected').count(), 0);
        assert.deepEqual(writes, []);
      } finally {
        owner.off('request', collect);
      }
    });

    await t.test('按原表行核实，筛选与分页保留意见，合计覆盖全批', async () => {
      await teacher.setViewportSize({ width: 1440, height: 900 });
      await teacher.goto(admin + '/hours');
      await teacher.getByRole('link', { name: /H2026-001/ }).click();
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      teacher.on('request', collect);
      try {
        await button(teacher, '预览通过整批').click();
        await visible(teacher.getByText('请核实原表第 4、6 行并填写意见'));
        await pickOption(teacher, '每页', '3 条');
        await button(teacher, '核实原表第4行').click();
        await teacher.getByLabel('属实', { exact: true }).check();
        await teacher.getByLabel('第4行意见').fill('已核实，未按时签到。');
        await button(teacher, '预览通过整批').click();
        await visible(teacher.getByText('请核实原表第 6 行并填写意见'));
        await teacher.getByLabel('不成立', { exact: true }).check();
        await teacher.getByLabel('第6行意见').fill('已核实补签记录。');
        await teacher.getByLabel('只看待核实行').check();
        await teacher.getByLabel('只看待核实行').uncheck();
        await pickOption(teacher, '每页', '5 条');
        await button(teacher, '核实原表第4行').click();
        assert.equal(await teacher.getByLabel('第4行意见').inputValue(), '已核实，未按时签到。');
        await visible(teacher.locator('.verify').getByText('示例学生 3', { exact: true }));
        assert.equal(await teacher.locator('tbody tr.selected th').innerText(), '4');
        assert.equal(await teacher.getByLabel('整批意见').inputValue(), '');
        await visible(teacher.getByText('全批 5 条 · 合计 10.0 小时'));
        await capture(teacher, 'hours');
        await button(teacher, '预览通过整批').click();
        await visible(teacher.getByText('输入完整，可通过整批（预览）'));
        assert.deepEqual(writes, []);
      } finally {
        teacher.off('request', collect);
      }
    });

    await t.test('活动发现保留搜索、校区、服务日期和报名阶段', async () => {
      const rev = await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id, revision: 1 },
      });
      const date = new Date(Date.parse(rev.content.schedule.starts_at) + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      await student.setViewportSize({ width: 390, height: 844 });
      await student.goto(web);
      await student.getByLabel('查找活动').fill(rev.content.title);
      await button(student, '搜索').click();
      await button(student, '筛选').click();
      await student.getByLabel('校区', { exact: true }).fill(rev.content.campus);
      await student.getByLabel('校区', { exact: true }).press('Tab');
      await pickOption(student, '报名阶段', '报名中');
      await student.getByLabel('服务日期', { exact: true }).fill(date);
      await link(student, rev.content.title).click();
      await link(student, '返回活动列表').click();
      await visible(link(student, rev.content.title));
      const query = new URL(student.url()).searchParams;
      assert.equal(query.get('date'), date);
      assert.equal(query.get('q'), rev.content.title);
      assert.equal(query.get('campus'), rev.content.campus);
      assert.equal(query.get('phase'), 'open');
      await student.setViewportSize({ width: 1440, height: 900 });
      await button(student, '上个月').click();
      await button(student, '下个月').click();
      assert.equal(await button(student, '筛选 ' + date).getAttribute('aria-pressed'), 'true');
      await button(student, '全部日期').click();
      await student.waitForURL((u) => !u.searchParams.has('date'));
      await visible(link(student, rev.content.title));
      await fits(student);
    });

    await t.test('日程切换四种时间刻度，返回后保留所选时段', async () => {
      await student.setViewportSize({ width: 1440, height: 900 });
      await student.goto(web + '/schedule?date=2026-11-18&view=chart&unit=week');
      const scale = student.getByRole('group', { name: '时间刻度' });
      await visible(student.locator('.chart tbody tr'));
      for (const [label, count] of [
        ['小时', 24],
        ['日', 6],
        ['月', 30],
        ['周', 7],
      ]) {
        await scale.getByRole('button', { name: label, exact: true }).click();
        assert.equal(await student.locator('.chart thead svg text').count(), count);
      }
      const segment = student.getByRole('button', { name: /校园服务甲.*14:15/ });
      await segment.focus();
      await student.keyboard.press('Enter');
      await visible(student.getByRole('complementary', { name: '时段详情' }));
      await capture(student, 'schedule-week');
      const week = student.url();
      await link(student, '查看真实获批详情').click();
      await link(student, '返回日程').click();
      await student.waitForURL(week);
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await student.setViewportSize({ width: 390, height: 844 });
      await student.goto(web + '/schedule?unit=hour&view=chart&date=2026-11-21');
      const morning = student.getByRole('button', { name: /校园服务甲.*09:30/ });
      await morning.focus();
      await student.keyboard.press('Enter');
      await button(student, '返回日程').click();
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await visible(button(student, '查看活动'));
      await fits(student);
      await capture(student, 'schedule-hour');
      await button(student, '今天').click();
      assert.equal(
        await scale.getByRole('button', { name: '小时' }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(
        new URL(student.url()).searchParams.get('date'),
        new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      );
    });

    await t.test('三端菜单贴合触发框，报名阶段可以选回所有阶段', async () => {
      async function assertAnchor(trigger, list, expectedPlacement) {
        const box = list.locator('xpath=ancestor::*[contains(@class, "el-popper")][1]');
        await box.evaluate(async (el) => {
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const [anchor, menu] = await Promise.all([trigger.boundingBox(), box.boundingBox()]);
        assert.ok(anchor && menu);
        const placement = await box.getAttribute('data-popper-placement');
        if (expectedPlacement) assert.equal(placement, expectedPlacement);
        assert.ok(Math.abs(menu.x - anchor.x) < 2, JSON.stringify({ anchor, menu }));
        const gap =
          placement === 'top-start'
            ? anchor.y - (menu.y + menu.height)
            : menu.y - (anchor.y + anchor.height);
        assert.ok(Math.abs(gap - 4) < 2, JSON.stringify({ placement, gap, anchor, menu }));
        const view = trigger.page().viewportSize();
        assert.ok(menu.y >= -1 && menu.y + menu.height <= view.height + 1);
        assert.ok(menu.x >= -1 && menu.x + menu.width <= view.width + 1);
      }
      for (const width of [1440, 390]) {
        for (const [page, url] of [
          [student, web],
          [owner, web + '/managed-schedule'],
          [teacher, admin + '/schedule'],
        ]) {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(url);
          if (width === 390) await button(page, '筛选').click();
          const { trigger, list } = await openOptions(page, '报名阶段');
          await assertAnchor(trigger, list);
          assert.equal(await list.getByRole('option').first().innerText(), '所有阶段');
          await list.getByRole('option', { name: '报名中', exact: true }).click();
          await page.waitForURL((u) => u.searchParams.get('phase') === 'open');
          await pickOption(page, '报名阶段', '所有阶段');
          await page.waitForURL((u) => !u.searchParams.has('phase'));
        }
      }
      for (const width of [1440, 390]) {
        await teacher.setViewportSize({ width, height: 844 });
        await teacher.goto(admin + '/schedule');
        if (width === 390) await button(teacher, '筛选').click();
        for (const [label, initial, choice, key, value] of [
          ['校区', '所有校区', '沙河', 'campus', '沙河'],
          ['活动状态', '所有状态', '已发布', 'status', 'published'],
          ['展示版本', '工作版本', '获批版本', 'revision', 'published'],
          ['负责人', '所有负责人', '甲负责人', 'owner', '甲负责人'],
        ]) {
          const { trigger, list } = await openOptions(teacher, label);
          await assertAnchor(trigger, list);
          assert.equal(await list.getByRole('option').first().innerText(), initial);
          await list.getByRole('option', { name: choice, exact: true }).click();
          await teacher.waitForURL((u) => u.searchParams.get(key) === value);
          await pickOption(teacher, label, initial);
          await teacher.waitForURL((u) =>
            key === 'revision' ? u.searchParams.get(key) === 'working' : !u.searchParams.has(key),
          );
        }
        for (const [label, key] of [
          ['进行中', 'ongoing'],
          ['待审核', 'pending'],
        ]) {
          const check = teacher.getByRole('checkbox', { name: label, exact: true });
          await check.check();
          await teacher.waitForURL((u) => u.searchParams.get(key) === '1');
          await check.uncheck();
          await teacher.waitForURL((u) => !u.searchParams.has(key));
        }
      }
      await teacher.setViewportSize({ width: 1440, height: 900 });
      await teacher.goto(admin + '/schedule');
      let previousList;
      for (const label of ['校区', '报名阶段', '活动状态', '展示版本', '负责人', '校区']) {
        const { trigger, list } = await openOptions(teacher, label);
        if (previousList) await previousList.waitFor({ state: 'hidden' });
        await assertAnchor(trigger, list);
        assert.equal(await list.getAttribute('aria-label'), label);
        previousList = list;
      }
      await teacher.keyboard.press('Escape');
      await teacher.setViewportSize({ width: 1280, height: 320 });
      await teacher.goto(admin + '/schedule');
      const { trigger, list } = await openOptions(teacher, '报名阶段');
      await assertAnchor(trigger, list, 'top-start');
      await teacher.evaluate(() => window.scrollTo(0, 140));
      await assertAnchor(trigger, list);
      await teacher.setViewportSize({ width: 1140, height: 600 });
      await assertAnchor(trigger, list);
      await teacher.keyboard.press('Escape');
      await list.waitFor({ state: 'hidden' });
      await teacher.setViewportSize({ width: 1440, height: 900 });
    });

    await t.test('审核日程左右日期箭头、日历和视图按钮按当前时间刻度切换', async () => {
      for (const width of [390, 1440]) {
        await teacher.setViewportSize({ width, height: 844 });
        await teacher.goto(admin + '/schedule?date=2026-11-18&unit=day');
        const trigger = teacher.getByRole('button', { name: /^查看日期/ });
        await trigger.click();
        const dateBox = teacher.locator('.schedule-date-menu:visible');
        await dateBox.waitFor();
        await dateBox.evaluate(async (el) => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const [box, anchor] = await Promise.all([dateBox.boundingBox(), trigger.boundingBox()]);
        const expectedLeft = Math.max(6, Math.min(anchor.x, width - box.width - 6));
        assert.ok(Math.abs(box.x - expectedLeft) <= 2);
        assert.ok(
          Math.min(
            Math.abs(box.y - (anchor.y + anchor.height + 4)),
            Math.abs(anchor.y - (box.y + box.height + 4)),
          ) <= 2,
        );
        await dateBox.getByRole('button', { name: '下个月', exact: true }).click();
        await dateBox.getByRole('button', { name: '选择 2026-12-31', exact: true }).click();
        await teacher.waitForURL((u) => u.searchParams.get('date') === '2026-12-31');
        await trigger.click();
        const dateInput = dateBox.getByRole('textbox', { name: '输入日期' });
        await dateInput.fill('2026-02-30');
        await dateInput.press('Enter');
        await visible(dateBox.getByRole('alert'));
        await dateInput.fill('2026-12-31');
        await dateInput.press('Enter');
        await dateBox.waitFor({ state: 'hidden' });
        const scale = teacher.getByRole('group', { name: '时间刻度' });
        for (const [label, previous, next, nextDate, backDate] of [
          ['小时', '前一天', '后一天', '2027-01-01', '2026-12-31'],
          ['日', '前一天', '后一天', '2027-01-01', '2026-12-31'],
          ['周', '上一周', '下一周', '2027-01-04', '2026-12-28'],
          ['月', '上个月', '下个月', '2027-01-01', '2026-12-01'],
        ]) {
          await scale.getByRole('button', { name: label, exact: true }).click();
          const [before, dateButton, after] = await Promise.all([
            button(teacher, previous).boundingBox(),
            trigger.boundingBox(),
            button(teacher, next).boundingBox(),
          ]);
          assert.ok(
            before.x + before.width <= dateButton.x + 1 &&
              dateButton.x + dateButton.width <= after.x + 1,
          );
          assert.ok(Math.abs(before.y + before.height / 2 - (after.y + after.height / 2)) <= 1);
          await button(teacher, next).click();
          await teacher.waitForURL((u) => u.searchParams.get('date') === nextDate);
          await button(teacher, previous).click();
          await teacher.waitForURL((u) => u.searchParams.get('date') === backDate);
        }
        await button(teacher, '今天').click();
        assert.equal(
          new URL(teacher.url()).searchParams.get('date'),
          new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
        );
        assert.equal(
          await scale.getByRole('button', { name: '月', exact: true }).getAttribute('aria-pressed'),
          'true',
        );
        for (const [label, view] of [
          ['列表', 'list'],
          ['时间轴', 'chart'],
        ]) {
          await button(teacher, label).click();
          await teacher.waitForURL((u) => u.searchParams.get('view') === view);
          assert.equal(await button(teacher, label).getAttribute('aria-pressed'), 'true');
        }
        await fits(teacher);
      }
    });

    await t.test('审核日程移除时间指针，桌面点击及手机轻触相邻色条可查看具体时段', async () => {
      await teacher.setViewportSize({ width: 890, height: 900 });
      await teacher.goto(admin + '/schedule?date=2026-11-18&unit=week&view=chart');
      const row = teacher.locator('.chart tbody tr').filter({ hasText: '校园服务甲' });
      await visible(row);
      assert.equal(await teacher.getByRole('slider').count(), 0);
      assert.equal(await teacher.locator('.now-line').count(), 0);
      const morning = row.getByRole('button', { name: /09:30 至/ });
      const afternoon = row.getByRole('button', { name: /14:15 至/ });
      const bars = await Promise.all([morning.boundingBox(), afternoon.boundingBox()]);
      assert.ok(
        Math.abs(bars[0].x + bars[0].width / 2 - (bars[1].x + bars[1].width / 2)) < 22,
        '此宽度应复现两个扩展触控区重叠',
      );
      for (const [bar, time] of [
        [morning, '09:30'],
        [afternoon, '14:15'],
      ]) {
        await bar.click();
        await teacher.waitForURL((u) => u.searchParams.get('slot')?.includes('T' + time));
        assert.equal(await teacher.locator('.time-choices').count(), 0);
        await visible(teacher.getByRole('complementary', { name: '时段详情' }));
      }
      const touch = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        storageState: await teacher.context().storageState(),
      });
      try {
        const phone = await touch.newPage();
        await phone.goto(admin + '/schedule?date=2026-11-18&unit=week&view=chart');
        await phone.getByRole('button', { name: /校园服务甲.*14:15 至/ }).tap();
        await phone.waitForURL((u) => u.searchParams.get('slot')?.includes('T14:15'));
        await visible(phone.getByRole('complementary', { name: '时段详情' }));
        assert.equal(await phone.locator('.time-choices').count(), 0);
      } finally {
        await touch.close();
      }
      await teacher.setViewportSize({ width: 1440, height: 900 });
    });

    await t.test('撤回或驳回后工作区和表单回到获批版本，原内容可再次选用', async () => {
      await owner.goto(web + '/managed/' + first.id + '/edit');
      const title = owner.getByLabel('活动标题', { exact: true });
      await title.fill('准备撤回的标题');
      await button(owner, '保存草稿').click();
      await visible(owner.getByRole('heading', { name: '准备撤回的标题', exact: true }));
      await button(owner, '提交审核').click();
      await owner.getByLabel('撤回原因').fill('调整后重送');
      await button(owner, '撤回送审').click();
      await visible(owner.getByRole('heading', { name: '校园服务甲', exact: true }));
      assert.equal(await title.inputValue(), '校园服务甲');
      await owner.getByRole('button', { name: /使用版本 .* 的内容重新编辑/ }).click();
      assert.equal(await title.inputValue(), '准备撤回的标题');
      assert.equal(await button(owner, '提交审核').count(), 0);
      await button(owner, '保存草稿').click();
      await button(owner, '提交审核').click();
      await visible(button(owner, '撤回送审'));
      await teacher.goto(admin + '/reviews');
      await teacher.getByRole('link', { name: /准备撤回的标题/ }).click();
      await teacher.getByLabel('审核意见（驳回必填）').fill('沿用原安排');
      await button(teacher, '驳回').click();
      await visible(teacher.getByText('已驳回', { exact: true }).first());
      await owner.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(owner.getByText(/处理意见.*沿用原安排/));
      assert.equal(await title.inputValue(), '校园服务甲');
    });

    await t.test('学生申请、负责人单人录取，学生查看结果与入群方式', async () => {
      await student.goto(web);
      await link(student, '校园服务甲').click();
      const instructions = '录取后向负责人领取群号';
      assert.equal(await student.getByText(instructions, { exact: true }).count(), 0);
      await student.getByText('报名说明（选填）', { exact: true }).click();
      await student.getByLabel('申请说明').fill('可准时到场');
      await button(student, '申请报名').click();
      await visible(button(student, '已提交，待审核'));

      await owner.goto(web + '/managed');
      await link(owner, '校园服务甲').click();
      await link(owner, '报名名单').click();
      await owner.getByLabel('姓名或学号').fill('0000000001');
      await button(owner, '查看体验学生').click();
      await visible(owner.getByText('可准时到场', { exact: true }));
      await button(owner, '录取此人').click();
      await visible(owner.getByText('已录取体验学生。', { exact: true }));

      await student.goto(web);
      await link(student, '我的报名').click();
      await student.getByRole('link', { name: /校园服务甲.*已录取/ }).click();
      await visible(student.getByText('已录取', { exact: true }));
      await link(student, '查看活动详情').click();
      await visible(student.getByText(instructions, { exact: true }));
      const row = await db.registration.findFirstOrThrow({
        where: { activity_id: first.id, student: { student_no: '0000000001' } },
      });
      assert.equal(row.status, 'accepted');
      assert.equal(
        await db.registrationDecisionEvent.count({ where: { registration_id: row.id } }),
        1,
      );
    });

    await t.test('会话到期后在原表单重试，兼任负责人保留管理入口', async () => {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(web);
        await page.getByLabel('账号', { exact: true }).fill('demo.dual');
        await page.getByLabel('当前密码').fill(password);
        await ctx.clearCookies();
        await button(page, '登录').click();
        await visible(page.getByText('登录页面已过期，会话已更新，请再次登录。'));
        await page.getByLabel('当前密码').fill('wrong-password');
        await button(page, '登录').click();
        await visible(page.getByText('账号或密码不正确'));
        await page.getByLabel('当前密码').fill(password);
        await button(page, '登录').click();
        await visible(button(page, '退出登录'));
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await visible(link(page, width === 390 ? '管理' : '我的管理活动'));
          for (const label of ['我的报名', '通知', '我的'])
            assert.equal(await link(page, label).count(), 0);
        }
        await link(page, '管理').click();
        await visible(link(page, '返回活动列表'));
        await link(page, '返回活动列表').click();
        await link(page, '校园服务甲').click();
        assert.equal(await link(page, '我的报名').count(), 0);
        assert.equal(await button(page, '申请报名').isEnabled(), false);
        await page.goto(web + '/registrations');
        await visible(page.getByRole('alert').filter({ hasText: '当前账号无学生个人页面权限' }));
      } finally {
        await ctx.close();
      }
    });

    await t.test('跨页查看最早版本时保留当前草稿输入', async () => {
      const activity = await db.activity.findUniqueOrThrow({
        where: { activity_code: 'TEST-20' },
        include: { revisions: true },
      });
      const original = activity.revisions[0];
      await db.activityRevision.update({
        where: { activity_id_revision: { activity_id: activity.id, revision: 1 } },
        data: { revision_state: 'rejected' },
      });
      await db.activityRevision.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          activity_id: activity.id,
          revision: i + 2,
          revision_state: i === 19 ? 'draft' : 'withdrawn',
          created_by: original.created_by,
          content: { ...original.content, title: '历史标题' + (i + 2) },
        })),
      });
      await db.activity.update({ where: { id: activity.id }, data: { working_revision: 21 } });
      await owner.goto(web + '/managed/' + activity.id + '/edit');
      const title = owner.getByLabel('活动标题', { exact: true });
      await title.fill('正在编辑中');
      const history = owner.locator('details.history');
      await history.getByText('版本历史', { exact: true }).click();
      await visible(button(history, '版本 21 · 草稿'));
      await button(history, '下一页').click();
      await button(history, '版本 1 · 已驳回').click();
      await visible(history.getByText(original.content.title, { exact: true }));
      assert.equal(await button(history, '下一页').isDisabled(), true);
      await button(history, '上一页').click();
      await visible(button(history, '版本 21 · 草稿'));
      assert.equal(await title.inputValue(), '正在编辑中');
    });

    if (process.env.UI_CAPTURE_DIR) {
      // Build an approved weekly revision inside this test's disposable database.
      const approved = await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id, revision: 1 },
      });
      const day = 86400000;
      const beijingToday = new Date(Date.now() + 8 * 3600000);
      const offset = (6 - beijingToday.getUTCDay() + 7) % 7;
      const firstSaturday = offset < 2 ? offset + 7 : offset;
      const dateAt = (days) =>
        new Date(beijingToday.getTime() + days * day).toISOString().slice(0, 10);
      const content = {
        ...approved.content,
        title: '图书馆志愿服务',
        campus: '沙河校区',
        location: '图书馆',
        description: '协助图书整理、书架归位与阅读区引导。',
        beneficiaries: '在校师生',
        meeting_point: '图书馆一层服务台',
        transport_notes: '校内步行到达',
        eligibility_text: '本学院学生，按要求参加培训',
        selection_text: '负责人审核',
        hours_rule_text: '以实际服务记录为准',
        capacity: 30,
        expected_hours: '2.0',
        expected_hours_basis: 'per_occurrence',
        registration_opens_at: dateAt(-1) + 'T09:00:00+08:00',
        registration_closes_at: dateAt(firstSaturday - 1) + 'T18:00:00+08:00',
        result_expected_at: dateAt(firstSaturday - 1) + 'T20:00:00+08:00',
        schedule: {
          schedule_type: 'weekly',
          duration_start_date: dateAt(firstSaturday),
          duration_end_date: dateAt(firstSaturday + 28),
          weekly_slots: [{ weekday: 6, start_time: '14:00', end_time: '16:00', end_day_offset: 0 }],
        },
      };
      const weekly = await db.activity.create({
        data: {
          activity_code: 'UI-0021',
          status: 'published',
          working_revision: 1,
          published_revision: 1,
          members: { create: { account_id: approved.created_by, member_role: 'owner' } },
          revisions: {
            create: {
              revision: 1,
              revision_state: 'approved',
              approved_at: new Date(),
              created_by: approved.created_by,
              content,
            },
          },
        },
      });
      await student.setViewportSize({ width: 1440, height: 900 });
      await student.goto(web);
      await visible(link(student, content.title));
      await capture(student, 'discovery');
      await student.setViewportSize({ width: 390, height: 844 });
      await fits(student);
      await capture(student, 'discovery-phone');
      await student.goto(web + '/?page=1&q=' + encodeURIComponent(content.title));
      const request = student.waitForResponse((r) =>
        r.url().endsWith('/api/v1/activities/' + weekly.id),
      );
      await link(student, content.title).click();
      assert.ok((await request).ok());
      await visible(student.getByText('每周参加报名在活动群内完成。'));
      await visible(student.getByText('报名中', { exact: true }));
      await visible(student.getByText(/每次 2.0 小时/));
      await fits(student);
      const cutoff = await student.locator('.facts mark').boundingBox();
      const action = await button(student, '申请报名').boundingBox();
      assert.ok(
        cutoff && action && cutoff.y + cutoff.height < action.y && action.y + action.height <= 844,
      );
      assert.ok(await button(student, '申请报名').isEnabled());
      await capture(student, 'student');
      await link(student, '返回活动列表').click();
      assert.equal(new URL(student.url()).searchParams.get('q'), content.title);
      assert.equal(new URL(student.url()).searchParams.get('page'), '1');
      await student.goto(web + '/activities/' + first.id);
      await visible(student.getByText('单次活动', { exact: true }));
      assert.equal(await student.getByText('每周参加报名在活动群内完成。').count(), 0);
    }
    await t.test('负责人上传并逐行核对时长、下载报告、修正重传和原批重试', async () => {
      await checkHourPages(owner, web, db, first.id, { pickOption, fits });
    });
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await Promise.all(servers.map((server) => server.close()));
      } finally {
        await api?.close();
      }
    }
  }
});
