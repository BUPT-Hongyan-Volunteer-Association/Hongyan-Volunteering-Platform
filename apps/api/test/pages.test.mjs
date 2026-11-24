import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { launchBrowser } from '../scripts/browser.mjs';
import { preview } from 'vite';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { Database } from '../dist/database.js';
import { slots } from '../dist/activities/schedule.js';
import { checkHourPages } from './hour-pages-fixture.mjs';
import { checkStudentImportPages } from './student-import-pages-fixture.mjs';
import { checkLedgerPages } from './hour-ledger-pages.mjs';
import {
  atTime,
  createScheduleDataset,
  createScheduleDemo,
  createWeeklyRevisionPair,
  moveActivityTo,
  presetRegistration,
  setActivityOwner,
} from './timeline-fixture.mjs';

const shiftDay = (date, days) =>
  new Date(Date.parse(date + 'T00:00:00+08:00') + 8 * 3600_000 + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const link = (page, name) => page.getByRole('link', { name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const visible = (locator) => locator.first().waitFor({ state: 'visible' });

async function publicSchedulePage(browserPage, date, q, page) {
  const url = new URL('/api/v1/timeline', browserPage.url());
  url.search = new URLSearchParams({
    scope: 'public', from: atTime(date, '00:00'), to: atTime(shiftDay(date, 1), '00:00'),
    q, page: String(page), page_size: '20',
  }).toString();
  const response = await browserPage.request.get(url.href);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
}

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
  page.setDefaultTimeout(12000);
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
async function holdResponse(page, pattern, overrides = {}) {
  const received = Promise.withResolvers(),
    release = Promise.withResolvers(),
    delivered = Promise.withResolvers();
  await page.route(
    pattern,
    async (route) => {
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      await route.fulfill({ response, ...overrides });
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

test('三端页面、真实发布与报名录取流程', { timeout: 480000 }, async (t) => {
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
    const helper = await signIn(browser, web, '0000000004', password, 390);
    const teacher = await signIn(browser, admin, 'demo.teacher', password, 1440);
    const tech = await signIn(browser, admin, 'demo.admin', adminPassword, 1440);
    const db = api.get(Database);
    const first = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });
    const firstStart = (
      await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id, revision: first.published_revision ?? 1 },
      })
    ).content.schedule.starts_at;
    const firstDate = new Date(Date.parse(firstStart) + 8 * 3600_000).toISOString().slice(0, 10);
    const demo = await createScheduleDemo(db);

    await t.test('宽屏正文铺满侧栏以外的空间，收起侧栏后随之扩展', async () => {
      for (const page of [student, owner, teacher]) {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
      await link(student, '校园服务甲').click();
      await link(owner, '我的管理活动').click();
      for (const page of [student, owner, teacher]) {
        const rail = await page.locator('.app-rail').boundingBox();
        const main = await page.getByRole('main').boundingBox();
        assert.equal(main.x, rail.x + rail.width);
        const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
        assert.equal(main.x + main.width, viewportWidth);
        await fits(page);
      }
      const detail = student.locator('.activity-detail');
      await visible(detail);
      const detailWidths = await detail.evaluate((article) => {
        const main = article.closest('main');
        const style = getComputedStyle(main);
        return {
          actual: article.getBoundingClientRect().width,
          available: main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      });
      assert.equal(detailWidths.actual, detailWidths.available);
      await button(teacher, '收起导航').click();
      const main = await teacher.getByRole('main').boundingBox();
      assert.equal(main.x, 0);
      assert.equal(main.width, await teacher.evaluate(() => document.documentElement.clientWidth));
      await button(teacher, '展开导航').click();
    });

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
        await visible(student.getByText('0.0 小时', { exact: true }));
        await fits(student);
        await link(student, '返回我的').click();
        await link(student, '本人记录与反馈').click();
        await visible(link(student, '提交漏记反馈'));
        await fits(student);
        await link(student, '返回我的').click();
        await link(student, '我的日程').click();
        await visible(student.getByText('该窗口和筛选条件下没有活动'));
        await link(student, '活动').click();
        await link(student, '活动日程').click();
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
          '时长台账',
          '漏记反馈',
          '错账修复组',
          '异常记录',
        ]) {
          const nav = owner.getByRole('navigation', { name: '活动工作区' });
          const parent = { '退出与恢复': '报名名单', '漏记反馈': '时长台账', '错账修复组': '时长台账', '异常记录': '现场人员记录' }[tab];
          if (parent) await link(nav, parent).click();
          await link(parent ? owner.getByRole('main') : nav, tab).click();
          await visible(nav.locator('a.current').filter({ hasText: parent ?? tab }));
          if (tab === '通知与回执') {
            await visible(owner.getByText(/本活动还没有发出过通知/));
            await fits(owner);
            continue;
          }
          if (tab === '时长批次') {
            await visible(owner.getByText('本活动还没有上传批次。'));
            assert.ok(await button(owner, '上传并预览').isDisabled());
            await fits(owner);
            continue;
          }
          if (tab === '现场人员记录') {
            await visible(owner.getByText('本活动暂无现场异常。'));
            await visible(button(owner, '登记异常'));
            await fits(owner);
            continue;
          }
          const empty = {
            退出与恢复: '暂无符合条件的退出申请。',
            漏记反馈: '当前没有反馈。',
            错账修复组: '当前没有修复组。',
            时长台账: '当前条件下没有时长记录。',
            异常记录: '没有异常记录。',
          }[tab];
          if (empty) {
            await visible(owner.getByText(empty, { exact: true }));
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
          '账号与角色',
          '通知失败队列',
        ]) {
          await nav.getByRole('link', { name: section, exact: true }).click();
          const empty = {
            错账修复组: '当前没有修复组。',
            异常复核: '没有异常记录。',
            申诉与更正: '当前没有反馈。',
          }[section];
          if (empty) {
            await visible(teacher.getByText(empty, { exact: true }));
            await fits(teacher);
            continue;
          }
          await teacher.locator('main .entry-list a').first().click();
          await visible(teacher.locator('article dl'));
          await fits(teacher);
          await link(teacher, '返回' + section).click();
        }
        await nav.getByRole('link', { name: '审计记录', exact: true }).click();
        await teacher.waitForURL('**/manage/audit');
        await visible(teacher.getByRole('heading', { name: '审计记录' }));
        await visible(teacher.getByLabel('操作者 ID'));
        await button(teacher, '查询').click();
        await visible(teacher.locator('table, .empty-state').first());
        await fits(teacher);
        await link(teacher, '全院日程').click();
        await visible(teacher.locator(width === 390 ? '.schedule-list' : '.chart-scroll'));
        await fits(teacher);
      }
    });

    await t.test('老师从后台导入学生名单并在学生档案中查到新学生', async () => {
      await checkStudentImportPages(teacher, admin, { fits, pickOption, db });
    });

    await t.test('时间轴按真实安排绘制分段，当前线取自服务端时刻', async (t) => {
      await student.setViewportSize({ width: 1440, height: 900 });
      await student.goto(web + '/schedule');
      const ongoing = student.locator('.chart tbody tr').filter({ hasText: '正在进行演示' });
      await visible(ongoing);
      assert.ok((await student.locator('.now-line').count()) > 0);
      assert.equal(await student.getByRole('slider').count(), 0);

      // 同一进行中的活动，负责人只看到接口给出的状态时刻文字。
      const organizer = await signIn(browser, web, '0000000003', password, 1440);
      t.after(() => organizer.context().close());
      const response = organizer.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/timeline');
      await organizer.goto(web + '/managed-schedule?unit=day&view=chart');
      const { data } = await (await response).json();
      await visible(organizer.locator('.chart tbody tr').filter({ hasText: '正在进行演示' }));
      const clockText = new Date(data.state_evaluated_at).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit',
      });
      assert.match(await organizer.locator('.view-caption').innerText(), /状态时刻/);
      assert.ok((await organizer.locator('.view-caption').innerText()).includes(clockText));
      assert.equal(await organizer.locator('.chart .now-line, .chart thead path[fill="#003399"]').count(), 0);
      assert.equal(await organizer.getByRole('slider').count(), 0);

      await student.getByLabel('进行中').check();
      await student.waitForURL((u) => u.searchParams.get('ongoing') === '1');
      await button(student, '列表').click();
      assert.equal(await student.locator('.schedule-list li').count(), 1);
      await button(student, '正在进行演示').click();
      await button(student, '时间轴').click();
      await visible(student.getByRole('complementary', { name: '时段详情' }));
      assert.ok(await student.getByLabel('进行中').isChecked());
      await student.keyboard.press('Escape');
      await student.waitForURL((u) => !u.searchParams.has('item'));

      await student.goto(web + '/schedule?date=' + demo.anchor + '&view=chart&unit=week');
      const row = student.locator('.chart tbody tr').filter({ hasText: '校园服务丙' });
      await visible(row);
      assert.equal(await row.locator('rect').count(), 3);
      const widths = await row
        .locator('rect')
        .evaluateAll((segments) => segments.map((s) => Number(s.getAttribute('width'))));
      assert.ok(Math.abs(widths[0] / widths[1] - 135 / 75) < 0.001);
      assert.ok(Math.abs(widths[2] / widths[1] - 90 / 75) < 0.001);

      await student.setViewportSize({ width: 390, height: 900 });
      await student.goto(web + '/schedule?date=' + demo.anchor + '&unit=hour&view=chart');
      const bar = student.getByRole('button', { name: /校园服务丙.*09:30/ });
      await visible(bar);
      assert.equal(await student.locator('.now-line').count(), 0);
      await bar.focus();
      await student.keyboard.press('Enter');
      await visible(student.getByText(/09:30 至 .*10:45/));
      await student.reload();
      await visible(student.getByRole('heading', { name: '校园服务丙' }));
      await button(student, '返回日程').click();
      await fits(student);
    });

    await t.test('公开地点获批后更新，学生确认变更，负责人可刷新回执', async () => {
      await student.goto(web);
      await link(student, '校园服务甲').click();
      const location = student.locator('dd').filter({ hasText: '沙河 · 活动室' });
      await visible(location);
      assert.equal(await location.innerText(), '沙河 · 活动室 A');
      await owner.goto(web + '/managed/' + first.id + '/edit');
      await visible(button(owner, '保存草稿'));
      assert.ok(await button(owner, '保存草稿').isDisabled());
      const oldContent = (await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id }, orderBy: { revision:'desc' },
      })).content;
      await owner.getByLabel('活动地点', { exact: true }).fill('活动室 B');
      await button(owner, '保存草稿').click();
      await visible(owner.getByText('草稿已保存', { exact: true }));
      const savedContent = (await db.activityRevision.findFirstOrThrow({
        where: { activity_id:first.id }, orderBy: { revision:'desc' },
      })).content;
      for (const key of ['schedule','registration_opens_at','registration_closes_at','result_expected_at','hours_import_expected_at'])
        assert.deepEqual(savedContent[key], oldContent[key]);
      await button(owner, '提交审核').click();
      await visible(owner.getByText('已送审，内容已冻结'));
      await student.reload();
      await visible(location);
      assert.equal(await location.innerText(), '沙河 · 活动室 A');
      // A failed connection check must leave the signed-in reviewer's write token intact.
      await teacher.route(url => ['/api/v1/me', '/api/v1/auth/csrf'].includes(url.pathname),
        route => route.abort('failed'), { times: 1 });
      await link(teacher, '连接状态').click();
      await visible(teacher.getByRole('heading', { name: '连接失败' }));
      await link(teacher, '全院日程').click();
      await teacher.getByLabel('待审核', { exact: true }).check();
      await teacher.goto(admin + '/schedule?date=' + firstDate + '&pending=1&unit=day');
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

      // 种子名单中 0000000004 已录取，0000000001 尚未报名。
      await api.get(NoticeWorker).drain();
      await helper.goto(web + '/activities/' + first.id);
      await link(helper, '去查看并确认').click();
      assert.equal(new URL(helper.url()).searchParams.get('activity_id'), first.id);
      await helper.setViewportSize({ width: 1440, height: 900 });
      await link(helper, '全部 1').click();
      const inbox = helper.locator('.summary-list');
      await visible(inbox.getByText(/活动地点：活动室 A → 活动室 B/));
      await capture(helper, 'notice-summary');
      const readingWidth = (await inbox.boundingBox()).width;
      await helper.setViewportSize({ width: 1920, height: 1080 });
      assert.equal((await inbox.boundingBox()).width, readingWidth);
      await fits(helper);
      await link(helper, '未读 1').click();
      const search = helper.getByRole('searchbox', { name: '搜索通知' });
      await search.fill('不存在的地点');
      await visible(helper.getByText('暂无匹配通知。'));
      await search.fill('活动室 B');
      await visible(inbox.getByText(/活动地点：活动室 A → 活动室 B/));
      await search.fill('');
      await link(helper, '全部 1').click();
      await helper.getByRole('link', { name: /校园服务甲安排有调整/ }).click();
      await visible(helper.getByText(/活动地点：活动室 A → 活动室 B/));
      await owner.goto(web + '/managed/' + first.id);
      await link(owner, '通知与回执').click();
      await owner.getByRole('link', { name: /校园服务甲安排有调整/ }).click();
      await pickOption(owner, '回执范围', '全部接收人');
      const receipt = owner.getByRole('row').filter({ hasText: '0000000004' });
      await visible(receipt.getByText('已读未确认', { exact: true }));
      assert.ok(await owner.locator('.record-list-pane').isVisible());
      await owner.setViewportSize({ width: 390, height: 844 });
      assert.equal(await owner.locator('.record-list-pane').isVisible(), false);
      await fits(owner);
      await link(helper, '查看活动详情').click();
      await link(helper, '返回通知详情').click();
      await link(helper, '返回通知').click();
      await link(helper, '待确认 1').click();
      await visible(link(helper, '未读 0'));
      await button(helper, '确认收到').click();
      await visible(helper.getByText('已确认收到，负责人可在回执里看到。'));
      await visible(link(helper, '待确认 0'));
      await visible(helper.getByText('没有待确认的通知。'));
      await button(owner, '刷新回执').click();
      await visible(receipt.getByText('已确认', { exact: true }));
      await button(owner, '导出回执').click();
      const exportDownload = owner.waitForEvent('download');
      await button(owner, '下载回执文件').click();
      const exportFile = await exportDownload;
      assert.match(exportFile.suggestedFilename(), /通知回执/);
      await fits(owner);
      await fits(helper);
    });

    await t.test('发布活动通知，收件箱去重提醒与筛选切换', async () => {
      await helper.clock.install();
      await helper.goto(web + '/notices');
      await visible(link(helper, '待确认 0'));
      await owner.goto(web + '/managed/' + first.id + '/notices');
      await link(owner, '发布通知').click();
      await owner.getByLabel('通知标题').fill('请带志愿者证件');
      await owner.getByLabel('通知正文').fill('请在签到时出示证件。');
      await pickOption(owner, '接收范围', '全部有效报名人员');
      await button(owner, '发布').click();
      await visible(owner.getByText('接收 1 人 · 待跟进 1 人'));

      const badge = helper.locator('.notice-badge');
      await helper.clock.fastForward(60_000);
      await visible(badge.getByText('1', { exact: true }));
      const notice = link(helper, '请带志愿者证件');
      await visible(notice);
      await link(helper, '未读 1').click();
      await helper.locator('[aria-busy="false"]').waitFor();
      // 全部另含已确认的地点变更；待确认应只显示本次发布的提醒。
      const slow = await holdResponse(helper, url => url.pathname.endsWith('/me/notices') &&
        url.searchParams.get('page_size') === '10' && !url.searchParams.has('unread_only') &&
        !url.searchParams.has('unacknowledged_only'));
      await link(helper, '全部 2').click();
      await slow.received;
      assert.ok(await helper.locator('[inert] a').filter({ hasText: '请带志愿者证件' }).isVisible());
      await link(helper, '待确认 1').click();
      await helper.locator('[aria-busy="false"]').waitFor();
      await slow.release();
      await settleRender(helper);
      assert.deepEqual(await helper.locator('.summary-list .summary-name a').allTextContents(), ['请带志愿者证件']);

      for (const width of [1440, 390]) {
        await helper.setViewportSize({ width, height: 900 });
        await fits(helper);
        const badgeBox = await badge.boundingBox();
        const anchor = await badge.locator('..').boundingBox();
        assert.ok(badgeBox.x >= anchor.x && badgeBox.x + badgeBox.width <= anchor.x + anchor.width);
        const action = button(helper, '确认收到');
        const box = await action.boundingBox(), area = await action.locator('..').boundingBox();
        assert.ok(Math.abs((box.x - area.x) * 2 + box.width - area.width) < 2);
      }
      await helper.setViewportSize({ width: 1440, height: 900 });
      await notice.click();
      const openedNotice = helper.getByRole('heading', { name: '请带志愿者证件', exact: true }).locator('..');
      await visible(openedNotice.getByText('已读未确认', { exact: true }));
      await visible(badge.getByText('1', { exact: true }));
      await link(helper, '返回通知').click();
      await link(helper, '全部 2').click();
      const releaseAck = Promise.withResolvers();
      await helper.route('**/me/notices/*/ack', async route => {
        await releaseAck.promise;
        await route.continue();
      }, { times: 1 });
      try {
        await button(helper, '确认收到').click();
        await link(helper, '待确认 1').click();
        await helper.locator('[aria-busy="false"]').waitFor();
        await visible(notice);
      } finally {
        releaseAck.resolve();
      }
      await badge.waitFor({ state: 'detached' });
      await visible(link(helper, '待确认 0'));
      await visible(helper.getByText('没有待确认的通知。'));
      assert.equal(await button(helper, '确认收到').count(), 0);
      await button(owner, '刷新回执').click();
      await visible(owner.getByText('接收 1 人 · 待跟进 0 人'));

      await link(owner, '发布通知').click();
      await owner.getByLabel('通知标题').fill('签到处开放时间');
      await owner.getByLabel('通知正文').fill('上午八点开放。');
      await owner.getByLabel('需要学生确认').uncheck();
      await button(owner, '发布').click();
      await visible(owner.getByText('0000000004', { exact: true }));
      // 同一浏览器会话切换身份，登录后的首次计数必须来自新账号。
      await helper.goto(web);
      await visible(badge.getByText('1', { exact: true }));
      for (const account of ['0000000001', '0000000004']) {
        await button(helper, '退出登录').click();
        await helper.getByLabel('账号', { exact: true }).fill(account);
        await helper.getByLabel('当前密码').fill(password);
        const counted = helper.waitForResponse(url => url.url().includes('/me/notices?') && url.status() === 200);
        await button(helper, '登录').click();
        await counted;
        if (account === '0000000001') assert.equal(await badge.count(), 0);
        else await visible(badge.getByText('1', { exact: true }));
      }
      await link(helper, '通知').click();
      await helper.getByRole('searchbox', { name: '搜索通知' }).fill('不存在的通知');
      await visible(helper.getByText('暂无匹配通知。'));
      assert.ok(await badge.isVisible());
      await helper.getByRole('searchbox', { name: '搜索通知' }).fill('');
      await link(helper, '签到处开放时间').click();
      await badge.waitFor({ state: 'detached' });
      assert.equal(await button(helper, '确认收到').count(), 0);
      await button(owner, '刷新回执').click();
      await visible(owner.getByRole('cell', { name: '已读', exact: true }));
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
    await t.test('指定通知接收人可跨页勾选，回执只含所选学生', async () => {
      await owner.goto(web + '/managed/' + first.id + '/notices');
      await link(owner, '发布通知').click();
      await owner.getByLabel('通知标题').fill('分组签到');
      await owner.getByLabel('通知正文').fill('请到第二签到点。');
      await pickOption(owner, '接收范围', '指定人员');
      const picker = owner.getByRole('group', { name: '选择接收人' });
      const choice = picker.locator('.choices label').nth(1);
      const expected = [];
      for (const page of [1, 2]) {
        if (page === 2) await button(picker, '下一页').click();
        await choice.getByRole('checkbox').check();
        expected.push(await choice.locator('small').innerText());
      }
      const staleChoice = picker.locator('.choices label').nth(2);
      await staleChoice.getByRole('checkbox').check();
      const student_no = await staleChoice.locator('small').innerText();
      const stale = await db.registration.findFirstOrThrow({ where: { activity_id: first.id, student: { student_no } } });
      await db.registration.update({ where: { id: stale.id }, data: { status: 'withdrawn' } });
      try {
        await button(owner, '发布').click();
        await visible(owner.getByRole('alert').filter({ hasText: student_no }));
        await visible(picker.getByText('已选 2 人'));
        assert.ok(await staleChoice.getByRole('checkbox').isDisabled());
      } finally {
        await db.registration.update({ where: { id: stale.id }, data: { status: stale.status } });
      }
      await button(owner, '发布').click();
      await visible(owner.getByText('接收 2 人 · 待跟进 2 人'));
      for (const number of expected)
        await visible(owner.getByRole('cell', { name: number, exact: true }));
    });

    await t.test('名单勾选和账号示例不会发送业务写请求', async () => {
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      for (const p of [owner, tech]) p.on('request', collect);
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
      for (const p of [owner, tech]) p.off('request', collect);
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
        await student.goto(
          web + '/schedule?unit=hour&view=chart&date=' + demo.anchor + '&status=published',
        );
        const afternoon = student.getByRole('button', { name: /校园服务丙.*14:15/ });
        await afternoon.focus();
        await student.keyboard.press('Enter');
        await visible(student.getByRole('complementary', { name: '时段详情' }));
        const url = new URL(student.url());
        url.searchParams.set('date', demo.before);
        await student.goto(url.href);
        await visible(student.getByText('所选时段已移出当前窗口', { exact: true }));
        await student.waitForURL((u) => !u.searchParams.has('slot') && !u.searchParams.has('item'));
        assert.equal(new URL(student.url()).searchParams.get('status'), 'published');
        assert.equal(await student.locator('.schedule-detail').count(), 0);
        await visible(student.getByRole('button', { name: /校园服务丙.*09:15/ }));
      }
    });

    await t.test('切换活动清空名单选择，回收成员后移除已显示内容', async () => {
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
      await visible(helper.getByText('离开上次名单时已清空选择。'));
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
        for (const label of ['录取所选', '所选设为候补'])
          assert.ok(await button(owner, label).isEnabled());
        assert.ok(await button(owner, /^导出所选名单（2）$/).isEnabled());
        await button(owner, '已录取 18').click();
        await visible(owner.getByText('已选 0 人', { exact: true }));
        assert.equal(await owner.locator('tbody tr.selected').count(), 0);
        assert.deepEqual(writes, []);
      } finally {
        owner.off('request', collect);
      }
    });

    await t.test('报名名单跨页勾选后导出所选名单', async () => {
      await owner.goto(web + '/managed/' + first.id + '/roster');
      await owner.getByLabel('选择名单测试1', { exact: true }).check();
      await button(owner, '下一页').click();
      await owner.getByLabel('选择名单测试6', { exact: true }).check();
      await visible(owner.getByText('已选 2 人', { exact: true }));
      const download = owner.waitForEvent('download');
      await button(owner, /^导出所选名单（2）$/).click();
      await visible(button(owner, '下载所选名单'));
      await button(owner, '下载所选名单').click();
      assert.match((await download).suggestedFilename(), /报名名单/);
      await button(owner, '导出筛选结果').click();
      await visible(button(owner, '下载名单文件'));
      await button(owner, '已录取 18').click();
      await visible(owner.getByText('已选 0 人', { exact: true }));
      assert.equal(await button(owner, '下载名单文件').count(), 0);
      await owner.getByLabel('选择名单测试10', { exact: true }).check();
      await button(owner, /^导出所选名单（1）$/).click();
      await visible(button(owner, '下载所选名单'));
      await owner.getByLabel('选择名单测试10', { exact: true }).uncheck();
      await visible(owner.getByText('已选 0 人', { exact: true }));
      assert.equal(await button(owner, '下载所选名单').count(), 0);
      await fits(owner);
    });

    await t.test('跨页决定逐行定位旧版本并保留其余选择', async () => {
      await owner.goto(web + '/managed/' + first.id + '/roster');
      await owner.getByLabel('选择名单测试1', { exact: true }).check();
      await button(owner, '下一页').click();
      await owner.getByLabel('选择名单测试6', { exact: true }).check();
      await db.registration.updateMany({ where: { activity_id: first.id, student: { account: { display_name: '名单测试1' } } }, data: { version: { increment: 1 } } });
      async function submitWhileTurningPage(direction, visibleName, selectAdditional = false) {
        const held = await holdResponse(owner, '**/registration-decisions?*');
        await button(owner, '所选设为候补').click();
        try {
          await held.received;
          await button(owner, direction).click();
          const visibleRow = owner.getByLabel('选择' + visibleName, { exact: true });
          await visible(visibleRow);
          if (selectAdditional) {
            await visibleRow.check();
            await owner.getByLabel('所选人员的处理说明（选填）').fill('下一批说明');
          }
        } finally {
          await held.release();
        }
      }
      await submitWhileTurningPage('上一页', '名单测试1');
      await visible(owner.getByLabel('冲突记录').getByText(/名单测试1/));
      await visible(owner.getByText('已选 2 人', { exact: true }));
      await button(owner, '刷新名单复核').click();
      await button(owner, '移出选择').click();
      await submitWhileTurningPage('下一页', '名单测试7', true);
      await visible(owner.getByText('已将1 人设为候补。', { exact: true }));
      await visible(owner.getByText('已选 1 人', { exact: true }));
      assert.ok(await owner.getByLabel('选择名单测试7', { exact: true }).isChecked());
      assert.equal(await owner.getByLabel('所选人员的处理说明（选填）').inputValue(), '下一批说明');
    });

    await t.test('批量和个人说明分别投递，已录取人员仍可导出', async () => {
      await owner.goto(web + '/managed/' + first.id + '/roster');
      await owner.getByLabel('选择名单测试2', { exact: true }).check();
      await owner.getByLabel('所选人员的处理说明（选填）').fill('只给所选人员的说明');
      await button(owner, '查看名单测试2').click();
      await owner.getByLabel('给名单测试2的处理说明（选填）').fill('只给原详情的说明');
      await button(owner, '查看名单测试5').click();
      assert.equal(await owner.getByLabel('给名单测试5的处理说明（选填）').inputValue(), '');
      await button(owner, '不录取此人').click();
      await visible(owner.getByText('名单测试5已标为未录取。'));
      const record = await db.registration.findFirstOrThrow({ where: { activity_id: first.id, student: { account: { display_name: '名单测试5' } } } });
      assert.equal(record.decision_reason, null);
      await api.get(NoticeWorker).drain();
      const result = await db.notice.findFirstOrThrow({ where: { notice_kind: 'result', activity_id: first.id,
        receipts: { some: { student_id: record.student_id } } } });
      assert.doesNotMatch(result.body, /只给/);
      assert.equal(await owner.getByLabel('所选人员的处理说明（选填）').inputValue(), '只给所选人员的说明');
      await button(owner, '已录取 18').click();
      await owner.getByLabel('选择名单测试10', { exact: true }).check();
      assert.ok(await button(owner, '不录取所选').isDisabled());
      assert.ok(await button(owner, '导出所选名单（1）').isEnabled());
    });

    await t.test('已打开的报名名单在成员被移出后拒绝旧窗口决定', async () => {
      await helper.goto(web + '/managed/' + first.id + '/roster');
      await helper.getByLabel('选择名单测试1', { exact: true }).check();
      const account = await db.account.findUniqueOrThrow({ where: { username: '0000000004' } });
      const key = { activity_id: first.id, account_id: account.id };
      const member = await db.activityMember.delete({ where: { activity_id_account_id: key } });
      try {
        const response = helper.waitForResponse(r => r.url().includes('/registration-decisions') && r.request().method() === 'POST');
        await button(helper, '不录取所选').click();
        assert.equal((await response).status(), 404);
        await visible(helper.getByRole('alert'));
        assert.equal(await helper.getByLabel('选择名单测试1', { exact: true }).count(), 0);
      } finally {
        await db.activityMember.create({ data: member });
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
      await student.goto(web + '/schedule?date=' + demo.anchor + '&view=chart&unit=week');
      const scale = student.getByRole('group', { name: '时间刻度' });
      await visible(student.locator('.chart tbody tr'));
      const month = new Date(demo.anchor + 'T00:00:00Z');
      const daysInMonth = new Date(
        Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
      ).getUTCDate();
      for (const [label, count] of [
        ['小时', 24],
        ['日', 6],
        ['月', daysInMonth],
        ['周', 7],
      ]) {
        await scale.getByRole('button', { name: label, exact: true }).click();
        await student.waitForFunction(
          (expected) => document.querySelectorAll('.chart thead svg text').length === expected,
          count,
        );
      }
      const segment = student.getByRole('button', { name: /校园服务丙.*14:15/ });
      await segment.focus();
      await student.keyboard.press('Enter');
      await visible(student.getByRole('complementary', { name: '时段详情' }));
      const week = student.url();
      await link(student, '查看真实获批详情').click();
      await link(student, '返回日程').click();
      await student.waitForURL(week);
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await student.setViewportSize({ width: 390, height: 844 });
      await student.goto(web + '/schedule?unit=hour&view=chart&date=' + demo.anchor);
      const morning = student.getByRole('button', { name: /校园服务丙.*09:30/ });
      await morning.focus();
      await student.keyboard.press('Enter');
      await button(student, '返回日程').click();
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await visible(button(student, '查看活动'));
      await fits(student);
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
      for (const [page, url, width] of [
        [student, web, 390],
        [owner, web + '/managed-schedule', 1440],
        [teacher, admin + '/schedule', 390],
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
      await teacher.setViewportSize({ width: 1440, height: 900 });
      await teacher.goto(admin + '/schedule');
      const ownerAccount = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
      for (const [label, initial, choice, key, value] of [
        ['校区', '所有校区', '沙河校区', 'campus', '沙河校区'],
        ['活动状态', '所有状态', '已发布', 'status', 'published'],
        ['展示版本', '工作版本', '获批版本', 'revision', 'published'],
        ['负责人', '所有负责人', '乙负责人', 'owner', ownerAccount.id],
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
        // 审核端省略复位控件，日期只经日历与箭头调整。
        assert.equal(await button(teacher, '今天').count(), 0);
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
      await teacher.goto(
        admin + '/schedule?date=' + demo.anchor + '&unit=week&view=chart&q=' +
          encodeURIComponent('校园服务丙'),
      );
      const row = teacher.locator('.chart tbody tr').filter({ hasText: '校园服务丙' });
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
        await phone.goto(
          admin + '/schedule?date=' + demo.anchor + '&unit=week&view=chart&q=' +
            encodeURIComponent('校园服务丙'),
        );
        await phone.getByRole('button', { name: /校园服务丙.*14:15 至/ }).tap();
        await phone.waitForURL((u) => u.searchParams.get('slot')?.includes('T14:15'));
        await visible(phone.getByRole('complementary', { name: '时段详情' }));
        assert.equal(await phone.locator('.time-choices').count(), 0);
      } finally {
        await touch.close();
      }
      await teacher.setViewportSize({ width: 1440, height: 900 });
    });

    await t.test('日程 1-5 日程分页可重试，详情返回只补读到所选页，候选跨页可用', async (t) => {
      await student.setViewportSize({ width: 1440, height: 900 });
      const query = '?' + new URLSearchParams({ date: demo.paged, unit: 'day', view: 'list', q: '分页演示' });
      const timeline = (url) => url.pathname === '/api/v1/timeline';
      const requested = [];
      const recordPage = (req) => {
        const url = new URL(req.url());
        if (timeline(url)) requested.push(Number(url.searchParams.get('page')));
      };
      student.on('request', recordPage);
      t.after(() => student.off('request', recordPage));
      t.after(() => db.activity.deleteMany({ where: { activity_code: { startsWith: 'TL-92' } } }));
      const failOnce = (route) => route.fulfill({ status: 503, body: '' });
      const pageOnly = (page) => (url) => timeline(url) && url.searchParams.get('page') === page;

      await student.goto(web + '/schedule' + query);
      const rows = student.locator('.schedule-list li');
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));
      await student.route(pageOnly('2'), failOnce, { times: 1 });
      await student.locator('.schedule-more button').click();
      await button(student, '重试').click();
      await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      assert.deepEqual(requested, [1, 2, 1, 2], '追加只读下一页，失败时整段重试');
      assert.match(await rows.first().innerText(), /分页演示 01/);
      await rows.filter({ hasText: '分页演示 21' }).getByRole('button').first().click();
      const detail = student.getByRole('complementary', { name: '时段详情' });
      await visible(detail);
      const selectedUrl = student.url();
      await link(student, '查看真实获批详情').click();
      await visible(student.getByRole('heading', { name: '分页演示 21', exact: true }));
      requested.length = 0;
      await student.route(pageOnly('1'), failOnce, { times: 1 });
      await link(student, '返回日程').click();
      await button(student, '重新读取').click();
      await visible(detail.getByRole('heading', { name: '分页演示 21' }));
      await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      assert.deepEqual(requested, [1, 1, 2], '重新读取首页后只补到选中页');
      assert.equal(student.url(), selectedUrl);
      await pickOption(student, '活动状态', '已发布');
      await student.waitForURL((url) => url.searchParams.get('status') === 'published');
      await visible(detail.getByRole('heading', { name: '分页演示 21' }));
      assert.equal(new URL(student.url()).searchParams.get('slot'), new URL(selectedUrl).searchParams.get('slot'));
      await student.locator('.schedule-more button').click();
      await student.locator('.schedule-more').waitFor({ state: 'detached' });
      assert.equal(await rows.count(), 41);

      // 第 21 项的负责人只在第 2 页出现，首屏仍应可选。
      await teacher.setViewportSize({ width: 1440, height: 900 });
      await teacher.goto(admin + '/schedule' + query);
      await visible(teacher.locator('.schedule-list li').first());
      assert.equal(await teacher.locator('.schedule-list li').count(), 20);
      const { list } = await openOptions(teacher, '负责人');
      await list.getByRole('option', { name: '乙负责人', exact: true }).click();
      await teacher.waitForURL((u) => u.searchParams.get('owner') === demo.pagedOwner.id);
      await visible(teacher.locator('.schedule-list li').first());
      assert.equal(await teacher.locator('.schedule-list li').count(), 1);
      await pickOption(teacher, '负责人', '所有负责人');
      await visible(teacher.getByText('41 项（已显示 20）', { exact: false }));
    });

    await t.test('切换筛选时重新聚焦并读取失败，重试仍只显示新条件的结果', async () => {
      await student.goto(web + '/schedule?unit=week&view=list&date=' + demo.anchor);
      const rows = student.locator('.schedule-list li');
      await visible(rows.first());
      const pattern = (url) => url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === '没有匹配的活动';
      const pending = await holdResponse(student, pattern, { status: 503 });
      const search = student.getByRole('searchbox');
      await search.fill('没有匹配的活动');
      await search.press('Enter');
      await pending.received;
      try {
        await student.evaluate(() => window.dispatchEvent(new Event('focus')));
        await settleRender(student);
        assert.equal(await rows.count(), 0);
      } finally {
        await pending.release();
      }
      await visible(button(student, '重新读取'));
      assert.equal(await rows.count(), 0);
      await button(student, '重新读取').click();
      await visible(student.getByText('该窗口和筛选条件下没有活动'));
    });

    await t.test('日程 1-7 切换展示版本不展示旧稿，权限收回时清空数据和详情', async () => {
      const pending = await db.activity.findUniqueOrThrow({
        where: { activity_code: 'P2026-0002' },
      });
      const latest = await db.activityRevision.findFirstOrThrow({
        where: { activity_id: pending.id },
        orderBy: { revision: 'desc' },
      });
      const title = latest.content.title;
      await teacher.setViewportSize({ width: 1440, height: 900 });
      await teacher.goto(
        admin + '/schedule?date=' + demo.anchor + '&unit=week&view=list&revision=working&q=' +
          encodeURIComponent(title),
      );
      await visible(teacher.locator('.schedule-list li').first());
      await teacher.locator('.schedule-list li').first().getByRole('button').first().click();
      const detail = teacher.getByRole('complementary', { name: '时段详情' });
      await visible(detail.getByRole('heading', { name: title }));
      // 刷新在途时切到获批版本：旧工作稿的行与详情在切换那一刻撤下，不等旧响应收尾。
      const inflight = await holdResponse(
        teacher,
        (url) =>
          url.pathname === '/api/v1/timeline' && url.searchParams.get('revision_scope') === 'working',
      );
      await teacher.evaluate(() => window.dispatchEvent(new Event('focus')));
      await inflight.received;
      await pickOption(teacher, '展示版本', '获批版本');
      await visible(teacher.getByText('正在读取活动日程…'));
      assert.equal(await teacher.locator('.schedule-list li').count(), 0, '切换那一刻旧工作稿的行即不可见');
      assert.equal(await teacher.locator('.schedule-detail').count(), 0);
      await inflight.release();
      await visible(teacher.getByText('该窗口和筛选条件下没有活动'));
      assert.equal(
        await teacher.locator('.schedule-list li').count(),
        0,
        '随后到达的旧响应不把旧稿写回',
      );

      // 权限被收回：清空旧管理数据与已打开详情。
      await teacher.goto(
        admin + '/schedule?date=' + demo.anchor + '&unit=week&view=list&revision=working&q=' +
          encodeURIComponent(title),
      );
      await visible(teacher.locator('.schedule-list li').first());
      await teacher.locator('.schedule-list li').first().getByRole('button').first().click();
      await visible(teacher.getByRole('complementary', { name: '时段详情' }));
      await teacher.route('**/api/v1/timeline**', (route) => route.fulfill({ status: 503, body: '' }), { times: 1 });
      await teacher.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(teacher.getByText('状态待刷新，请重试', { exact: false }));
      assert.ok(await teacher.locator('.schedule-detail').isVisible());
      await teacher.route('**/api/v1/timeline**', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'forbidden',
            message: '当前身份无权执行此操作',
            request_id: randomUUID(),
          }),
        }),
      );
      try {
        await button(teacher, '重试').click();
        await visible(teacher.getByText(/无权查看该日程范围/));
      } finally {
        await teacher.unroute('**/api/v1/timeline**');
      }
      assert.equal(await teacher.locator('.schedule-list li').count(), 0);
      assert.equal(await teacher.locator('.schedule-detail').count(), 0);
      assert.equal(new URL(teacher.url()).searchParams.has('item'), false);
    });

    await t.test('审核日程时间轴同时显示进行中与待审核', async () => {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const account = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
      const approved = await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id, revision: 1 },
      });
      const dayMs = 86400000;
      const revised = await db.activity.create({
        data: {
          activity_code: 'TL-9301',
          status: 'published',
          working_revision: 2,
          published_revision: 1,
          members: { create: { account_id: account.id, member_role: 'owner' } },
          revisions: {
            create: [
              {
                revision: 1,
                revision_state: 'approved',
                approved_at: new Date(),
                created_by: account.id,
                content: {
                  ...approved.content,
                  title: '待审修订演示',
                  schedule: {
                    schedule_type: 'continuous',
                    starts_at: new Date(Date.now() - 1800_000).toISOString(),
                    ends_at: new Date(Date.now() + 1800_000).toISOString(),
                  },
                },
              },
              {
                revision: 2,
                revision_state: 'pending_review',
                created_by: account.id,
                content: {
                  ...approved.content,
                  title: '待审修订演示',
                  schedule: {
                    schedule_type: 'continuous',
                    starts_at: new Date(Date.now() + 5 * dayMs).toISOString(),
                    ends_at: new Date(Date.now() + 5 * dayMs + 5400_000).toISOString(),
                  },
                },
              },
            ],
          },
        },
      });
      await db.activityReview.create({
        data: { activity_id: revised.id, revision: 2, submitted_by: account.id },
      });
      try {
        await teacher.setViewportSize({ width: 1200, height: 900 });
        for (const revision of ['working', 'published']) {
          await teacher.goto(
            admin + '/schedule?date=' + today + '&unit=month&view=chart&revision=' + revision +
              '&q=' + encodeURIComponent('待审修订演示'),
          );
          const row = teacher.locator('.chart tbody tr').filter({ hasText: '待审修订演示' });
          await visible(row);
          const meta = await row.locator('small').innerText();
          assert.match(meta, /进行中/);
          assert.match(meta, /待审核/);
        }
      } finally {
        await db.activityReview.deleteMany({ where: { activity_id: revised.id } });
        await db.activity.delete({ where: { id: revised.id } });
      }
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

      await link(student.locator('.activity-detail'), '我的报名').click();
      await link(student, '办理与进度').click();
      const original = student.url().split('/registrations/')[1].split('?')[0];
      await button(student, '撤回报名').click();
      await visible(student.getByText('已撤回报名。', { exact: true }));
      await link(student, '查看活动详情').click();
      await student.getByText('报名说明（选填）', { exact: true }).click();
      await student.getByLabel('申请说明').fill('可准时到场');
      await button(student, '重新申请报名').click();
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
      await visible(student.locator('.summary-list li').filter({ hasText: '校园服务甲' }).getByText('可准时到场', { exact: false }));
      await visible(student.getByText('已录取', { exact: true }));
      await link(student, '查看活动详情').click();
      await visible(student.getByText(instructions, { exact: true }));
      await link(student, '返回我的报名').click();
      await visible(student.locator('.summary-list').getByText('已录取'));
      const row = await db.registration.findFirstOrThrow({
        where: { activity_id: first.id, student: { student_no: '0000000001' } },
      });
      assert.equal(row.id, original);
      assert.equal(row.status, 'accepted');
      assert.equal(
        await db.registrationDecisionEvent.count({ where: { registration_id: row.id } }),
        1,
      );
    });

    await t.test('学生和负责人办理退出与恢复，保留原报名', async () => {
      await link(student, '办理与进度').click();
      const detail = student.url();
      await student.getByLabel('申请原因').fill('时间冲突');
      const refreshed = student.waitForResponse(r => r.url().includes('/me/exit-requests?'));
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await refreshed;
      assert.equal(await student.getByLabel('申请原因').inputValue(), '时间冲突');
      // 焦点刷新先读回旧报名和空申请队列，才放行真实写入。
      const intercepted = Promise.withResolvers(), release = Promise.withResolvers();
      await student.route('**/api/v1/me/exit-requests', async route => {
        intercepted.resolve();
        await release.promise;
        await route.continue();
      }, { times: 1 });
      await button(student, '申请退出整项活动').click();
      try {
        await intercepted.promise;
        const reread = student.waitForResponse(r => r.url().includes('/me/exit-requests?'));
        await student.evaluate(() => window.dispatchEvent(new Event('focus')));
        await reread;
        await visible(student.getByText('暂无符合条件的退出申请。', { exact: true }));
      } finally {
        release.resolve();
      }
      await visible(button(student, '撤回退出申请'));
      await visible(student.getByText('退出申请已提交。', { exact: true }));
      await owner.setViewportSize({ width: 1440, height: 900 });
      const queueReads = [];
      const countReads = req => {
        const url = new URL(req.url());
        if (req.method() === 'GET' && url.pathname.endsWith('/exit-requests'))
          queueReads.push(url.searchParams.has('request_id') ? 'detail' : 'list');
      };
      owner.on('request', countReads);
      await link(owner, '退出与恢复').click();
      const entry = owner.getByRole('link', { name: /^处理申请 · 体验学生/ });
      await entry.click();
      await visible(button(owner, '批准退出'));
      await visible(entry);
      owner.off('request', countReads);
      assert.deepEqual(queueReads, ['list', 'detail']);
      const exitUrl = owner.url();
      await owner.reload();
      await visible(button(owner, '批准退出'));
      assert.equal(owner.url(), exitUrl);
      await owner.setViewportSize({ width: 390, height: 844 });
      assert.ok(await entry.isHidden());
      await fits(owner);
      await button(owner, '批准退出').click();
      await visible(owner.getByText('退出申请已批准。', { exact: true }));
      await student.reload();
      await visible(student.locator('.summary-list').getByText('已退出'));
      await student.getByLabel('申请原因').fill('时间已协调');
      await button(student, '申请恢复报名').click();
      await visible(button(student, '撤回恢复申请'));
      await link(owner, '返回申请列表').click();
      await link(owner, '恢复申请').click();
      await pickOption(owner, '申请状态', '全部状态');
      await entry.click();
      await visible(button(owner, '批准恢复'));
      const restorationUrl = owner.url();
      await link(owner, '返回申请列表').click();
      assert.equal(new URL(owner.url()).searchParams.get('kind'), 'restoration');
      assert.equal(new URL(owner.url()).searchParams.get('status'), 'all');
      // 无类型的旧链接须先定位详情，再用正确队列校正深分页。
      const heldLookup = await holdResponse(owner, '**/exit-requests?*request_id=*');
      const wrongListReads = [];
      const recordLookup = req => {
        const url = new URL(req.url());
        if (url.pathname.endsWith('/exit-requests') && !url.searchParams.has('request_id')) wrongListReads.push(req.url());
      };
      owner.on('request', recordLookup);
      try {
        await owner.goto(restorationUrl.split('?')[0] + '?request_page=2');
        await heldLookup.received;
        await settleRender(owner);
        assert.deepEqual(wrongListReads, []);
      } finally {
        owner.off('request', recordLookup);
        await heldLookup.release();
      }
      await visible(button(owner, '批准恢复'));
      await owner.waitForURL(url => url.searchParams.get('request_page') === '1' && url.searchParams.get('kind') === 'restoration');
      await button(owner, '批准恢复').click();
      await visible(owner.getByText('恢复申请已批准。', { exact: true }));
      await student.reload();
      await visible(student.locator('.summary-list').getByText('已录取'));
      assert.equal(student.url(), detail);
      await helper.goto(detail);
      await visible(helper.getByText('未找到该报名记录。'));
    });

    await t.test('上一条申请的复核完成不会解除当前申请的版本冲突', async () => {
      const requests = [];
      for (const name of ['名单测试10', '名单测试11']) {
        const r = await db.registration.findFirstOrThrow({ where: { activity_id: first.id, status: 'accepted', student: { account: { display_name: name } } } });
        requests.push(await db.exitRequest.create({ data: { registration_id: r.id, reason: '期末课程调整' } }));
      }
      const [a,b] = requests;
      const base = web + '/managed/' + first.id + '/requests';
      const withdrawElsewhere = row => db.exitRequest.update({ where: { id: row.id }, data: { version: { increment: 1 }, status: 'withdrawn' } });
      await owner.setViewportSize({ width: 1440, height: 900 });
      await owner.goto(base + '?kind=exit');
      await owner.getByRole('link', { name: /^处理申请 · 名单测试11 / }).click();
      await owner.getByRole('link', { name: /^处理申请 · 名单测试10 / }).click();
      await visible(button(owner, '批准退出'));
      await withdrawElsewhere(a);
      await button(owner, '批准退出').click();
      await visible(button(owner, '刷新复核'));
      const held = await holdResponse(owner, '**/exit-requests?*page_size=*');
      try {
        await button(owner, '刷新复核').click();
        await held.received;
        await owner.goBack();
        await visible(owner.getByRole('heading', { name: '名单测试11的退出申请' }));
        await withdrawElsewhere(b);
        await button(owner, '批准退出').click();
        await visible(button(owner, '刷新复核'));
      } finally {
        await held.release();
      }
      await settleRender(owner);
      assert.ok(await button(owner, '刷新复核').isVisible());
      assert.ok(await button(owner, '批准退出').isDisabled());
    });

    await t.test('会话到期后在原表单重试，兼任负责人保留管理入口', async () => {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(12000);
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

    await t.test('每周活动在手机首屏展示报名截止、时长和报名入口', async () => {
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
      await student.setViewportSize({ width: 390, height: 844 });
      await fits(student);
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
      await link(student, '返回活动列表').click();
      assert.equal(new URL(student.url()).searchParams.get('q'), content.title);
      assert.equal(new URL(student.url()).searchParams.get('page'), '1');
      await student.goto(web + '/activities/' + first.id);
      await visible(student.getByText('单次活动', { exact: true }));
      assert.equal(await student.getByText('每周参加报名在活动群内完成。').count(), 0);
    });
    await t.test('新建按日活动：标题草稿、补全送审、分钟滚轮和管理日程', async () => {
      await owner.setViewportSize({ width: 1440, height: 900 });
      await owner.goto(web + '/managed/new');
      await owner.getByLabel('活动标题', { exact: true }).fill('跨校区图书整理');
      await button(owner, '保存草稿').click();
      await owner.waitForURL(/managed\/[\w-]+\/edit/);
      const editUrl = owner.url();
      await owner.goto(web + '/managed');
      await visible(owner.getByText('日期待定', { exact: true }));
      await owner.goto(editUrl);
      await button(owner, '提交审核').click();
      await visible(owner.getByRole('list', { name: '待修正字段' }));
      await owner.waitForFunction(() => document.activeElement?.id === 'activity-beneficiaries');
      for (const [label, value] of Object.entries({
        服务对象: '全校师生',
        服务内容: '整理书架',
        活动地点: '图书馆',
        集合地点: '一层服务台',
        交通说明: '校内步行',
        计划名额: '10',
        '联系方式 1': '13800000000',
        入群方式: '群号 123456',
        时长认定说明: '以实际服务为准',
      }))
        await owner.getByLabel(label, { exact: true }).fill(value);
      await button(owner, '新增联系方式').click();
      await owner.getByLabel('联系方式 2', {exact:true}).fill('Library_old');
      await button(owner, '新增联系方式').click();
      await owner.getByLabel('联系方式 3', {exact:true}).fill('library@example.org');
      await button(owner, '删除联系方式 2').click();
      assert.equal(await owner.getByLabel('联系方式 2',{exact:true}).inputValue(), 'library@example.org');
      await button(owner, '新增联系方式').click();
      await owner.getByLabel('联系方式 3',{exact:true}).fill('13900000000');
      await pickOption(owner, '校区', '沙河及西土城校区');
      await owner.getByLabel('群二维码', { exact: true }).setInputFiles({
        name: 'group.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kSAAAAAASUVORK5CYII=',
          'base64',
        ),
      });
      await visible(owner.getByAltText('入群二维码预览'));
      await owner.waitForFunction(() => document.querySelector('.group-qr')?.naturalWidth > 0);
      async function chooseDate(label, day) {
        await button(owner, label).click();
        const panel = owner.locator('.schedule-date-menu:visible');
        await panel.getByLabel('输入日期').fill(day);
        await button(panel, '确定').click();
        await panel.waitFor({ state: 'hidden' });
      }
      for (const [label, day] of [
        ['活动开始日期', '2027-05-01'],
        ['活动结束日期', '2027-05-02'],
        ['预计时长导入日期', '2027-05-06'],
        ['报名开放日期', '2027-04-30'],
        ['报名截止日期', '2027-05-01'],
        ['预计结果公布日期', '2027-05-01'],
      ])
        await chooseDate(label, day);
      assert.equal(await owner.locator('.field.invalid').count(), 0);
      assert.equal(await owner.locator('.field').filter({hasText:'预计结果公布日期'}).getByRole('combobox').count(), 0);
      const time = owner.getByRole('combobox', { name: '报名截止时分' });
      await time.click();
      const clock = owner.locator('.activity-clock:visible');
      await visible(clock);
      assert.equal(await clock.locator('.el-time-spinner__list').count(), 2);
      const minutes = clock.locator('.el-time-spinner__list').nth(1);
      for (let attempt = 0; attempt < 5; attempt++) {
        await minutes.locator('.is-active').hover();
        await owner.mouse.wheel(0, 64);
        try {
          await owner.waitForFunction(() => {
            const list = document.querySelectorAll('.activity-clock .el-time-spinner__list')[1];
            return !!list && list.querySelector('.is-active')?.textContent?.trim() !== '00';
          }, null, { timeout: 2000 });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }
      await time.press('ArrowRight');
      await time.press('ArrowDown');
      await clock.getByText('确定', { exact: true }).click();
      const chosen = await time.inputValue();
      assert.match(chosen, /^\d{2}:\d{2}$/);
      assert.notEqual(chosen, '09:00');
      await owner.setViewportSize({ width: 390, height: 844 });
      await time.click();
      await time.press('ArrowDown');
      await clock.getByText('取消', { exact: true }).click();
      assert.equal(await time.inputValue(), chosen);
      await fits(owner);
      await button(owner, '保存草稿').click();
      await visible(owner.getByText('草稿已保存', { exact: true }));
      await owner.reload();
      assert.equal(await owner.getByLabel('联系方式 3',{exact:true}).inputValue(),'13900000000');
      assert.match(await button(owner,'预计结果公布日期').innerText(),/2027-05-01/);
      assert.equal(await time.inputValue(), chosen);
      await owner.waitForFunction(() => document.querySelector('.group-qr')?.naturalWidth > 0);
      await button(owner, '提交审核').click();
      await visible(owner.getByText('已送审，内容已冻结', { exact: true }));
      const activityId = new URL(editUrl).pathname.split('/')[2];
      const review = await db.activityReview.findFirstOrThrow({where:{activity_id:activityId,status:'pending'}});
      await teacher.goto(admin + '/reviews/' + review.id);
      await button(teacher,'批准发布').click();
      await visible(teacher.getByText('已批准发布',{exact:true}));
      await student.goto(web + '/activities/' + activityId);
      await student.getByText('录取、时长与报名时间',{exact:true}).click();
      assert.equal(await student.locator('dt').filter({hasText:'结果公布'}).locator('+ dd').innerText(),'2027-05-01');
      await button(student,'联系负责人').click();
      const contactDialog = student.getByRole('dialog',{name:'联系负责人'});
      for (const text of ['13800000000','library@example.org','13900000000'])
        await visible(contactDialog.getByText(text,{exact:true}));
      await button(contactDialog,'关闭').click();
      for (const unit of ['hour', 'day', 'week', 'month']) {
        await owner.goto(web + '/managed-schedule?date=2027-05-01&view=chart&unit=' + unit);
        const row = owner.locator('.chart tbody tr').filter({ hasText: '跨校区图书整理' });
        await visible(row);
        assert.equal(
          await owner.locator('.now-line, .chart thead path[fill="#003399"]').count(),
          0,
        );
        await row.getByRole('button').first().click();
        await visible(owner.getByRole('complementary', { name: '时段详情' }));
      }
    });

    await t.test('负责人上传并逐行核对时长、下载报告、修正重传和原批重试', async () => {
      await checkHourPages(owner, web, db, first.id, { pickOption, fits });
    });

    await t.test('负责人跨页批量登记现场异常并可按日期查回和撤销', async () => {
      const activity = await db.activity.findUniqueOrThrow({ where: { id: first.id } });
      const { content } = await db.activityRevision.findUniqueOrThrow({
        where: { activity_id_revision: { activity_id: first.id, revision: activity.published_revision } },
      });
      const [slot] = slots(content.schedule);
      const date = new Date(Date.parse(slot.starts_at) + 8 * 3600000).toISOString().slice(0, 10);
      await owner.setViewportSize({ width: 1440, height: 900 });
      await owner.goto(web + '/managed');
      await link(owner, '校园服务甲').click();
      await link(owner, '现场人员记录').click();
      await visible(owner.getByText('本活动暂无现场异常。'));
      await button(owner, '登记异常').click();
      await owner.getByLabel('登记服务日期').fill(date);
      await pickOption(owner, '异常类型', '迟到');
      const people = owner.getByRole('group', { name: '报名人员' });
      const firstChoice = people.locator('.choices label').nth(1);
      await firstChoice.getByRole('checkbox').check();
      const firstName = await firstChoice.locator('span').innerText();
      await owner.getByLabel('记录说明（选填）').fill('第一时段因交通延误');
      await button(people, '下一页').click();
      await visible(people.getByText(/第 2 \/ /));
      assert.notEqual(await firstChoice.locator('span').innerText(), firstName);
      await firstChoice.getByRole('checkbox').check();
      await visible(people.getByText('已选 2 人'));
      const other = await owner.context().newPage();
      await other.goto(owner.url());
      const otherDate = other.getByLabel('服务日期', { exact: true });
      await otherDate.fill('2000-01-01');
      await visible(other.getByText('该日期暂无现场异常。'));
      await button(other, '登记异常').click();
      await other.getByLabel('登记服务日期').fill(date);
      const otherRoster = other.getByRole('group', { name: '报名人员' });
      await otherRoster.locator('.choices label').nth(2).getByRole('checkbox').check();
      const duplicateNo = await firstChoice.locator('small').innerText();
      await otherRoster.getByRole('searchbox').fill(duplicateNo);
      await button(otherRoster, '搜索').click();
      await visible(otherRoster.getByText('搜索条件已变更，已清空选择。'));
      await visible(otherRoster.getByText('已选 0 人'));
      assert.ok(await button(other, '保存记录').isDisabled());
      await otherRoster.locator('label').filter({ hasText: duplicateNo }).getByRole('checkbox').check();
      await fits(owner);
      await capture(owner, 'attendance-form');
      await button(owner, '保存记录').click();
      await visible(owner.getByText('已登记 2 条现场异常。'));
      const table = owner.getByRole('table', { name: '现场人员记录' });
      const dataRows = table.getByRole('row').filter({ hasText: '第一时段因交通延误' });
      await visible(dataRows.nth(1));
      assert.equal(await table.getByRole('cell', { name: '迟到', exact: true }).count(), 2);
      const duplicateResponse = other.waitForResponse((response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/attendance'));
      await button(other, '保存记录').click();
      const conflict = await duplicateResponse;
      assert.equal(conflict.status(), 409);
      assert.equal(new URL(conflict.url()).searchParams.get('scope'), 'managed');
      const duplicateRow = await db.student.findUniqueOrThrow({ where: { student_no: duplicateNo } });
      assert.deepEqual(conflict.request().postDataJSON().student_ids, [duplicateRow.id]);
      await button(other, '查看该日记录').click();
      await visible(other.getByText('共 2 条异常'));
      assert.equal(await otherDate.inputValue(), date);
      await visible(other.getByRole('table').getByText(duplicateNo, { exact: true }));
      await other.close();
      await owner.reload();
      await visible(dataRows.nth(1));
      const filter = owner.getByLabel('服务日期', { exact: true });
      await filter.fill('2000-01-01');
      await visible(owner.getByText('该日期暂无现场异常。'));
      await filter.fill(date);
      await visible(dataRows.nth(1));

      await button(dataRows.first(), '修改').click();
      await pickOption(owner, '异常类型', '自定义');
      const reason = owner.getByLabel('异常原因（必填）');
      await reason.fill('');
      assert.ok(await button(owner, '保存修改').isDisabled());
      await reason.fill('临时换岗');
      await button(owner, '保存修改').click();
      const changed = table.getByRole('row').filter({ hasText: '临时换岗' });
      await visible(changed);
      await visible(table.getByRole('cell', { name: '自定义' }));
      await capture(owner, 'attendance-register');

      await owner.setViewportSize({ width: 390, height: 844 });
      await settleRender(owner);
      await fits(owner);
      await capture(owner, 'attendance-mobile');
      await button(changed, '修改').click();
      await button(owner, '撤销记录').click();
      await visible(owner.getByText('共 1 条异常'));
      assert.equal(await changed.count(), 0);

      await button(owner, '登记异常').click();
      await pickOption(owner, '异常类型', '未报名参加');
      const unregistered = await db.student.findMany({
        where: { student_no: { in: ['0000000002', '0000000003'] }, registrations: { none: { activity_id: first.id } } },
        include: { account: true },
        orderBy: { student_no: 'asc' },
      });
      assert.equal(unregistered.length, 2);
      await button(owner, '添加人员').click();
      const manual = owner.getByRole('group', { name: '未报名人员' });
      for (const [index, person] of unregistered.entries()) {
        await manual.getByLabel('学号', { exact: true }).nth(index).fill(person.student_no);
        await manual.getByLabel('姓名', { exact: true }).nth(index).fill(person.account.display_name);
      }
      await owner.getByLabel('异常原因（必填）').fill('现场临时替补');
      await fits(owner);
      await button(owner, '保存记录').click();
      await visible(owner.getByText('共 3 条异常'));
      const supplemented = table.getByText('未报名参加', { exact: true });
      await visible(supplemented.nth(1));
      assert.equal(await supplemented.count(), 2);
      await fits(owner);
    });
    await t.test('四个账号完成真实送审、入账、错账修复和分别结案，逐行审核跨页保留意见', async () => {
      await checkLedgerPages({ db, web, admin, owner, teacher, student, secondStudent: helper,
        worker: api.get(NoticeWorker), fits, pickOption, capture, holdResponse, settleRender });
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
        '&unit=day&view=list&revision=' +
        revision +
        '&q=' +
        encodeURIComponent(title);
      const detail = teacher.getByRole('complementary', { name: '时段详情' });
      const row = teacher.locator('.schedule-list li').filter({ hasText: title });
      const mineAt =
        web + '/mine/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title);
      const mineRow = student.locator('.schedule-list li').filter({ hasText: title });

      // 同一项活动的两版：获批版 A 是两条例行时段，待审版 B 停办当日例行时段、只留补充的 16:15。
      await teacher.goto(scheduleAt('published'));
      await visible(row);
      assert.match(await row.innerText(), /09:30/);
      assert.match(await row.innerText(), /14:15/);
      assert.doesNotMatch(await row.innerText(), /16:15/);
      assert.equal(await row.locator('.slot-list button').count(), 2);
      await teacher.goto(scheduleAt('working'));
      await visible(row);
      assert.match(await row.innerText(), /16:15/);
      assert.doesNotMatch(await row.innerText(), /09:30|14:15/);
      assert.equal(await row.locator('.slot-list button').count(), 1);
      assert.match(await row.locator('.meta-line').innerText(), /待审核/);

      // 驳回：工作版本回落到获批版，所选 16:15 在窗内消失，按第 3 种清除并说明。
      await row.getByRole('button', { name: /16:15/ }).click();
      await visible(detail.getByRole('heading', { name: title }));
      assert.equal(new URL(teacher.url()).searchParams.has('slot'), true);
      const beforeReject = new URL(teacher.url());
      await link(teacher, '查看待审版本').click();
      await visible(button(teacher, '驳回'));
      await teacher.getByLabel('审核意见（驳回必填）').fill('按原安排执行');
      await button(teacher, '驳回').click();
      await teacher.waitForURL((url) => url.pathname === '/schedule');
      await visible(teacher.getByText('已驳回', { exact: true }));
      await visible(teacher.getByText('所选时段已随安排更新失效，已回到日程。'));
      await teacher.waitForURL(
        (url) => !url.searchParams.has('item') && !url.searchParams.has('slot'),
      );
      assert.equal(await teacher.locator('.schedule-detail').count(), 0);
      const afterReject = new URL(teacher.url());
      for (const key of ['date', 'unit', 'view', 'revision', 'q'])
        assert.equal(afterReject.searchParams.get(key), beforeReject.searchParams.get(key));
      await visible(row);
      assert.match(await row.innerText(), /09:30/);
      assert.match(await row.innerText(), /14:15/);
      assert.doesNotMatch(await row.innerText(), /16:15/);

      // 学生端仍见获批版 A。
      await student.goto(mineAt);
      await visible(mineRow);
      assert.match(await mineRow.innerText(), /09:30/);
      assert.match(await mineRow.innerText(), /14:15/);
      assert.doesNotMatch(await mineRow.innerText(), /16:15/);

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
      assert.match(await row.innerText(), /16:15/);
      assert.match(await row.locator('.meta-line').innerText(), /待审核/);
      await row.getByRole('button', { name: /16:15/ }).click();
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
      await visible(detail.getByText(/16:15/));
      for (const key of ['item', 'slot'])
        assert.equal(afterApprove.searchParams.get(key), beforeApprove.searchParams.get(key));
      assert.equal(await teacher.getByText('所选时段已随安排更新失效，已回到日程。').count(), 0);
      assert.doesNotMatch(await row.locator('.meta-line').innerText(), /待审核/);

      // 学生端见获批版 B：只剩 16:15。
      await student.goto(mineAt);
      await visible(mineRow);
      assert.match(await mineRow.innerText(), /16:15/);
      assert.doesNotMatch(await mineRow.innerText(), /09:30|14:15/);

      // 只看待审核：处理完成后活动移出结果，页面给出空态。
      await teacher.goto(
        admin +
          '/schedule?date=' +
          date +
          '&unit=day&view=list&pending=1&q=' +
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
        web + '/mine/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent('范围变化甲'),
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
        '&unit=day&view=' +
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
      await managedRows.first().getByRole('button', { name: /10:00/ }).click();
      const detail = helper.getByRole('complementary', { name: '时段详情' });
      await visible(detail.getByRole('heading', { name: '交接演示甲' }));
      await setActivityOwner(db, { activityCode: 'TL-9412', username: '0000000004', attached: false });
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(helper.getByText('所选活动已移出当前筛选。'));
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
        web + '/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title),
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
              starts_at: atTime(shiftDay(date, 5), '10:00'),
              ends_at: atTime(shiftDay(date, 5), '12:00'),
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

      // 分段键取自同一结果，刷新后范围仍完整、选中保留。
      await rows.first().getByRole('button', { name: /10:00/ }).click();
      const detail = student.getByRole('complementary', { name: '时段详情' });
      await visible(detail.getByRole('heading', { name: expected[0] }));
      assert.equal(
        new URL(student.url()).searchParams.get('slot'),
        server[0].items[0].segments[0].occurrence_key,
      );
      requested.length = 0;
      await student.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(detail.getByRole('heading', { name: expected[0] }));
      assert.deepEqual([...requested].sort((a, b) => a - b), [1, 2], '刷新重读已加载的两页');

      // 侧栏不保留已失效的段：同日改时刻后所选时段键消失，活动仍在列表里（§2.2 第 3 种）。
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
      await visible(student.getByText('所选时段已随安排更新失效，已回到日程。'));
      await student.waitForURL((url) => !url.searchParams.has('slot'));
      assert.equal(await student.locator('.schedule-detail').count(), 0);
      assert.equal(new URL(student.url()).searchParams.has('slot'), false);
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
      const query = 'date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title);
      const timeline = (url) =>
        url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === title;
      const last = await db.activity.findUniqueOrThrow({ where: { activity_code: created.codes.at(-1) } });
      await teacher.goto(admin + '/schedule?' + query + '&item=' + last.id);
      const detail = teacher.getByRole('complementary', { name: '时段详情' });
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
      release();
      await switched;
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
      const at = web + '/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title);
      const loadTwoPages = async () => {
        await student.locator('.schedule-more button').click();
        await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      };

      await student.goto(at);
      const rows = student.locator('.schedule-list li');
      const detail = student.getByRole('complementary', { name: '时段详情' });
      await visible(student.getByText('41 项（已显示 20）', { exact: false }));
      await loadTwoPages();
      await rows.first().getByRole('button', { name: /10:00/ }).click();
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
      await student.goto(web + '/schedule?' + new URLSearchParams({ date, unit: 'day', view: 'list', q: title }));
      const more = student.locator('.schedule-more button');
      await more.click();
      await visible(student.getByText('41 项（已显示 40）', { exact: false }));
      await moveActivityTo(db, { activityCode: 'TL-97021', date: shiftDay(date, 5) });
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
        web + '/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title),
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
        web + '/schedule?date=' + shrink + '&unit=day&view=list&q=' + encodeURIComponent(shrinkTitle);
      const [target] = (await publicSchedulePage(student, shrink, shrinkTitle, 3)).items;
      // 首屏拿的是收缩前的快照，期间的删除让补读读到空页。
      const held = await holdResponse(
        student,
        (url) => url.pathname === '/api/v1/timeline' && url.searchParams.get('q') === shrinkTitle,
      );
      await student.goto(shrinkAt + '&item=' + target.activity_id + '&slot=' + encodeURIComponent(target.segments[0].occurrence_key));
      await held.received;
      await db.activity.deleteMany({
        where: { activity_code: { startsWith: 'TL-88', lt: 'TL-8822' } },
      });
      await held.release();
      const shrinkDetail = student.getByRole('complementary', { name: '时段详情' });
      await visible(shrinkDetail.getByRole('heading', { name: shrinkTitle + ' 41' }));
      await visible(student.getByText(/^20 项/));
      assert.equal(await rows.count(), 20, '旧页集合不被当成功提交');
      assert.equal(await rows.filter({ hasText: shrinkTitle + ' 01' }).count(), 0, '被删的活动不出现');
      assert.equal(await rows.filter({ hasText: shrinkTitle + ' 41' }).count(), 1);
      assert.equal(await student.getByText('所选活动已移出当前筛选').count(), 0);
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
      const at = web + '/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title);
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
      const at = web + '/schedule?date=' + date + '&unit=day&view=list&q=' + encodeURIComponent(title);

      // 跨午夜项按编码排在第 21 位，落在首屏之后。
      await student.goto(at);
      await visible(student.getByText('21 项（已显示 20）', { exact: false }));
      const [target] = (await publicSchedulePage(student, date, title, 2)).items;
      const slot = target.segments[0].occurrence_key;

      // 带选中直接进入：首屏读第 1 页后自动补读第 2 页，选中在跨午夜段上成立。
      await student.goto(at + '&item=' + target.activity_id + '&slot=' + encodeURIComponent(slot));
      const rows = student.locator('.schedule-list li');
      const detail = student.getByRole('complementary', { name: '时段详情' });
      await visible(detail.getByRole('heading', { name: title + ' 跨夜' }));
      assert.match(await detail.innerText(), /23:00 至 .*02:00/);
      assert.equal(await student.getByText('所选时段已移出当前窗口').count(), 0);
      await visible(rows.filter({ hasText: title + ' 跨夜' }));
      assert.equal(await rows.count(), 21, '补读未因开始时刻早于窗口首而提前退出');
      assert.equal(new URL(student.url()).searchParams.get('item'), target.activity_id);
      assert.equal(new URL(student.url()).searchParams.get('slot'), slot);

      // 时间轴同样有这一段。
      await button(student, '时间轴').click();
      await visible(
        student.getByRole('button', { name: new RegExp(title + ' 跨夜.*23:00 至 .*02:00') }),
      );
      await student.setViewportSize({ width: 390, height: 844 });
      await button(student, '返回日程').click();
      await visible(student.locator('.chart rect[aria-pressed=true]'));
      await visible(button(student, '查看活动'));
      assert.equal(new URL(student.url()).searchParams.get('slot'), slot);
      await student.setViewportSize({ width: 1440, height: 900 });
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
