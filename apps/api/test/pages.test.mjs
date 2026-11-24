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

const loginFailureMessage = '登录失败，请核对账号和密码。如果你刚办理过凭证重置，旧密码已失效，请联系办理老师确认发放进度。';
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

test('三端页面、真实发布与报名录取流程', { timeout: 4 * 60_000 }, async (t) => {
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
          '时长台账',
          '漏记反馈',
          '错账修复组',
          '异常记录',
        ]) {
          if (!(await link(owner, tab).isVisible()))
            await owner.getByText('更多', { exact: true }).click();
          await link(owner, tab).click();
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
          '审计记录',
        ]) {
          await nav.getByRole('link', { name: section, exact: true }).click();
          if (section === '账号与角色') {
            await visible(teacher.getByLabel('学生学号'));
            await fits(teacher);
            continue;
          }
          if (section === '审计记录') {
            await visible(teacher.getByRole('table', { name: section }).getByText('活动交接'));
            await fits(teacher);
            continue;
          }
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
        await link(teacher, '全院日程').click();
        await visible(teacher.locator(width === 390 ? '.schedule-list' : '.chart-scroll'));
        await fits(teacher);
      }
    });

    await t.test('老师从后台导入学生名单并在学生档案中查到新学生', async () => {
      await checkStudentImportPages(teacher, admin, { fits, pickOption, db });
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
      await fits(owner);
      await fits(helper);
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
    await t.test('名单批量预览和账号身份核对不会发送业务写请求', async () => {
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      for (const p of [owner, teacher, tech]) p.on('request', collect);
      await owner.goto(web + '/managed/' + first.id + '/roster');
      await owner.getByLabel('选择本页').check();
      await visible(owner.getByText(/已选 5 人/));
      const staff = await db.account.findUniqueOrThrow({ where: { username: 'demo.admin' } });
      const numbers = ['0190000001', '0190000002'];
      for (const username of numbers) await db.account.create({ data: {
        username, display_name: '合成同名', password_hash: 'fixture',
        roles: { create: { role: 'student' } }, student: { create: { student_no: username } },
      } });
      await teacher.goto(admin + '/');
      await link(teacher, '账号与角色').click();
      const input = teacher.getByLabel('学生学号');
      const card = teacher.getByRole('region', { name: '账号核对结果' });
      for (const number of numbers) {
        await input.fill(number);
        assert.equal(await card.count(), 0);
        await button(teacher, '查询账号').click();
        await visible(card.getByText(number, {exact:true}));
        await visible(card.getByRole('heading', {name:'合成同名'}));
      }
      await input.fill('0999999999');
      await button(teacher, '查询账号').click();
      await visible(teacher.getByText('没有找到可查看的账号，请核对学号。'));
      assert.equal(await card.count(), 0);
      await teacher.goto(admin + '/manage/accounts/' + staff.id);
      await visible(teacher.getByText('没有找到可查看的账号。'));
      await tech.goto(admin + '/manage/accounts/' + staff.id);
      await visible(tech.getByRole('heading', {name: staff.display_name}));
      await visible(tech.getByText('技术管理员', {exact:true}));
      assert.deepEqual(writes, []);
      for (const p of [owner, teacher, tech]) p.off('request', collect);
    });
    await t.test('技术管理员核对后建后台账号，老师保留学生建档入口', async () => {
      await teacher.goto(admin + '/manage/accounts');
      await visible(link(teacher, '导入学生名单建档'));
      assert.equal(await teacher.getByText('创建后台账号', { exact: true }).count(), 0);
      await tech.goto(admin + '/');
      await link(tech, '账号与角色').click();
      await tech.getByText('创建后台账号', { exact: true }).click();
      await tech.getByLabel('新账号登录名').fill('faculty.demo');
      await tech.getByLabel('姓名', { exact: true }).fill('合成教师');
      await tech.getByLabel('后台角色').selectOption('reviewer');
      await tech.getByLabel('创建原因').fill('合成验收');
      await button(tech, '核对创建信息').click();
      await visible(tech.getByRole('heading', { name: '核对后台账号' }));
      assert.equal(await db.account.count({ where: { username: 'faculty.demo' } }), 0);
      await button(tech, '确认创建').click();
      await visible(tech.getByText('已创建 faculty.demo，待发放初始凭证。'));
      await link(tech, '查看新账号详情').click();
      await visible(tech.getByText('待发放，暂不可登录'));
      await link(tech, '返回账号查询').click();
      await tech.getByLabel('登录账号', { exact: true }).fill('faculty.demo');
      await button(tech, '查询账号').click();
      await visible(tech.getByRole('heading', { name: '合成教师' }));
    });
    await t.test('管理员办理限期技术角色、收回授权，并看到最后一名长期管理员保护提示', async () => {
      await tech.goto(admin + '/manage/accounts');
      await teacher.goto(admin + '/manage/accounts');
      const lookup = async username => {
        await tech.getByLabel('登录账号', { exact: true }).fill(username);
        await button(tech, '查询账号').click();
        await tech.getByLabel('要办理的角色').selectOption('tech_admin');
      };
      await lookup('demo.teacher');
      await button(tech, '授予技术管理员角色').click();
      await visible(tech.getByText('长期授权没有到期日。', { exact: false }));
      await tech.getByLabel('限期授权').check();
      await tech.getByLabel('到期时间（北京时间）').fill('2099-12-31T12:00');
      await tech.getByLabel('办理原因').fill('代班期间维护账号');
      await button(tech, '保存技术管理员角色').click();
      await visible(tech.getByText('技术管理员角色已保存。'));
      await button(tech, '调整有效期').click();
      assert.equal(await tech.getByLabel('到期时间（北京时间）').inputValue(), '2099-12-31T12:00');
      await button(tech, '取消').click();
      await teacher.reload();
      await visible(teacher.getByText('创建后台账号', { exact: true }));
      await button(tech, '收回技术管理员角色').click();
      await tech.getByLabel('办理原因').fill('代班结束');
      await button(tech, '确认收回技术管理员角色').click();
      await visible(tech.getByText('技术管理员角色已收回。'));
      await teacher.reload();
      await visible(teacher.getByLabel('学生学号'));
      assert.equal(await teacher.getByText('创建后台账号', { exact: true }).count(), 0);
      await lookup('demo.admin');
      await button(tech, '调整有效期').click();
      await tech.getByLabel('限期授权').check();
      await tech.getByLabel('到期时间（北京时间）').fill('2099-12-31T12:00');
      await tech.getByLabel('办理原因').fill('核对长期管理员保护');
      await button(tech, '保存技术管理员角色').click();
      await visible(tech.getByRole('alert').filter({ hasText: '须保留至少一个可登录' }));
      await fits(tech);
    });
    await t.test('技术管理员停启独立账号，老师原窗口需重新登录', async () => {
      const affected = await signIn(browser, admin, 'demo.dual', password, 390);
      await tech.goto(admin + '/manage/accounts');
      await tech.getByLabel('登录账号', { exact: true }).fill('demo.dual');
      await button(tech, '查询账号').click();
      await button(tech, '停用账号').click();
      await visible(tech.getByText('停用账号 · 兼任审核员（demo.dual）'));
      await tech.getByLabel('办理原因').fill('轮岗交接');
      await button(tech, '确认停用').click();
      await visible(tech.getByText('账号已停用，所有旧会话已撤销。'));
      await affected.reload();
      await visible(button(affected, '登录'));
      await button(tech, '启用账号').click();
      await tech.getByLabel('办理原因').fill('恢复履职');
      await button(tech, '确认启用').click();
      await visible(tech.getByText('账号已启用。'));
      await affected.reload();
      await visible(button(affected, '登录'));
      await affected.getByLabel('账号', { exact: true }).fill('demo.dual');
      await affected.getByLabel('当前密码').fill(password);
      await button(affected, '登录').click();
      await visible(button(affected, '退出登录'));
      await tech.getByLabel('登录账号', { exact: true }).fill('demo.admin');
      await button(tech, '查询账号').click();
      await button(tech, '停用账号').click();
      await tech.getByLabel('办理原因').fill('核对最后一个管理员');
      await button(tech, '确认停用').click();
      await visible(tech.getByRole('alert').filter({ hasText: '须保留至少一个可登录' }));
      await affected.context().close();
    });
    await t.test('老师按身份卡授权与收回，学生原会话保留学生入口', async () => {
      await teacher.goto(admin + '/manage/accounts');
      const input = teacher.getByLabel('学生学号');
      await input.fill('0000000001');
      await button(teacher, '查询账号').click();
      await button(teacher, '授予负责人资格').click();
      await teacher.getByLabel('办理原因').fill('不应带到下个账号');
      await input.fill('0190000002');
      await button(teacher, '查询账号').click();
      await button(teacher, '授予负责人资格').click();
      assert.equal(await teacher.getByLabel('办理原因').inputValue(), '');
      await input.fill('0000000001');
      await button(teacher, '查询账号').click();
      await button(teacher, '授予负责人资格').click();
      await teacher.getByLabel('限期授权').check();
      await teacher.getByLabel('到期时间（北京时间）').fill('2099-06-30T23:59');
      await teacher.getByLabel('办理原因').fill('合成志愿服务授权');
      await button(teacher, '保存负责人资格').click();
      await visible(teacher.getByText('负责人资格已保存，本次操作不会分配活动。'));
      await visible(teacher.getByText(/有效至.*23:59/));
      await student.goto(web + '/managed');
      await visible(student.getByRole('heading', {name:'我的管理活动'}));
      await button(teacher, '收回负责人资格').click();
      await visible(teacher.getByText(/学生身份和历史记录保留/));
      await teacher.getByLabel('办理原因').fill('合成授权结束');
      await button(teacher, '确认收回资格').click();
      await visible(teacher.getByText('已收回负责人资格，学生身份保留。'));
      await student.reload();
      await visible(student.getByText('当前账号无活动管理权限。'));
      await student.goto(web + '/mine');
      await visible(button(student, '退出登录'));
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
        await button(owner, '已录取 18').click();
        await visible(owner.getByText('已选 0 人', { exact: true }));
        assert.equal(await owner.locator('tbody tr.selected').count(), 0);
        assert.deepEqual(writes, []);
      } finally {
        owner.off('request', collect);
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
      for (const [label, initial, choice, key, value] of [
        ['校区', '所有校区', '沙河', 'campus', '沙河'],
        ['活动状态', '所有状态', '已发布', 'status', 'published'],
        ['展示版本', '工作版本', '获批版本', 'revision', 'published'],
        ['负责人', '所有负责人', '同学甲', 'owner', '同学甲'],
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
      await visible(student.locator('.summary-list li').filter({ hasText: '校园服务甲' }).getByText('可准时到场', { exact: false }));
      await visible(student.getByText('已录取', { exact: true }));
      await link(student, '查看活动详情').click();
      await visible(student.getByText(instructions, { exact: true }));
      await link(student, '返回我的报名').click();
      await visible(student.locator('.summary-list').getByText('已录取'));
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
        await visible(page.getByText(loginFailureMessage, { exact: true }));
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
      await minutes.locator('.is-active').hover();
      await owner.mouse.wheel(0, 64);
      await owner.waitForFunction(() => {
        const list = document.querySelectorAll('.activity-clock .el-time-spinner__list')[1];
        return !!list && list.querySelector('.is-active')?.textContent?.trim() !== '00';
      });
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
        await owner.goto(web + '/managed-schedule?date=2026-11-18&view=chart&unit=' + unit);
        const row = owner.locator('.chart tbody tr').filter({ hasText: '校园服务甲' });
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
    await t.test('主负责人添加协作者并交接，移除原负责人后旧会话失去活动权限', async () => {
      const joined = await signIn(browser, web, '0000000003', password, 390);
      await joined.goto(web + '/managed/' + first.id);
      await visible(joined.getByRole('alert'));
      await owner.goto(web + '/managed');
      await link(owner, '校园服务甲').click();
      await owner.getByText('添加协作者', {exact:true}).click();
      const number = owner.getByLabel('协作者学号');
      await number.fill('0000000003');
      await button(owner, '查找负责人').click();
      const card = owner.getByRole('region', {name:'候选人核对'});
      await visible(card.getByText('同学乙 · 0000000003'));
      await visible(card.getByText(/仅获得本活动的协作权限/));
      await number.fill('0000000001');
      assert.equal(await card.count(), 0);
      await number.fill('0000000003');
      await button(owner, '查找负责人').click();
      await owner.getByLabel('添加原因').fill('活动引导');
      await button(owner, '确认添加协作者').click();
      await visible(owner.getByText('同学乙已加入本活动，身份为协作者。'));
      await number.fill('0000000003');
      await button(owner, '查找负责人').click();
      await visible(owner.getByText('已是本活动协作者，无需重复添加。'));
      await joined.reload();
      await visible(joined.getByText(/你是本活动的协作者/));
      assert.equal(await joined.getByText('添加协作者', {exact:true}).count(), 0);
      await fits(joined);
      await owner.getByText('交接主负责人', { exact: true }).click();
      await owner.getByLabel('接任协作者').selectOption({ label: '同学乙 · 0000000003' });
      await visible(owner.getByText(/你将保留协作者身份/));
      await owner.getByLabel('交接原因').fill('现场换班');
      await button(owner, '确认交接').click();
      await visible(owner.getByText(/你是本活动的协作者/));
      await joined.reload();
      await visible(joined.getByText('交接主负责人', { exact: true }));
      assert.equal(await owner.getByRole('button', { name: /移除协作者/ }).count(), 0);
      await link(owner, '报名名单').click();
      await visible(owner.locator('.status-filters'));
      const remove = button(joined, '移除协作者 同学甲');
      await remove.click();
      const dialog = joined.getByRole('dialog', { name: '移除协作者' });
      await visible(dialog.getByText(/校园服务甲.*同学甲.*0000000002/));
      assert.equal(await button(joined, '确认移除').isDisabled(), true);
      await button(joined, '取消').click();
      await remove.click();
      await joined.getByLabel('移除原因').fill('现场工作已交接');
      await fits(joined);
      await button(joined, '确认移除').click();
      await visible(joined.getByText('已从本活动移除同学甲。'));
      assert.equal(await remove.count(), 0);
      await owner.reload();
      await visible(owner.getByRole('alert').filter({ hasText: '记录不存在或不可见' }));
      assert.equal(await owner.locator('.status-filters').count(), 0);
      await owner.goto(web + '/managed/' + first.id + '/attendance');
      await visible(owner.getByRole('alert').filter({ hasText: '记录不存在或不可见' }));
      await owner.goto(web + '/mine');
      await visible(owner.getByRole('heading', { name: '同学甲' }));
      await link(teacher, '账号与角色').click();
      await teacher.getByLabel('学生学号').fill('0000000003');
      await button(teacher, '查询账号').click();
      await button(teacher, '收回负责人资格').click();
      await teacher.getByLabel('办理原因').fill('负责人离任');
      await button(teacher, '确认收回资格').click();
      await visible(teacher.getByText('已收回负责人资格，学生身份保留。'));
      await link(teacher, '活动团队').click();
      await teacher.getByLabel('活动名称或编号').fill('P2026-0001');
      await button(teacher, '查询活动').click();
      await link(teacher, '校园服务甲').click();
      await visible(teacher.getByText('当前没有负责人角色'));
      await teacher.getByLabel('接任人学号').fill('0000000002');
      await button(teacher, '核对接任人').click();
      await visible(teacher.getByText('同学甲 · 0000000002', { exact: true }));
      await teacher.getByLabel('添加原因').fill('补充接任协作者');
      await button(teacher, '确认添加协作者').click();
      await visible(teacher.getByText('同学甲已加入活动，请核对交接信息并填写交接原因。'));
      assert.equal(await teacher.getByLabel('交接原因').inputValue(), '');
      await teacher.getByLabel('交接原因').fill('老师核对后办理');
      await button(teacher, '确认重新指定').click();
      await visible(teacher.getByText('同学甲已接任主负责人。'));
      await visible(teacher.getByRole('heading', { name: '当前主负责人：同学甲' }));
      const team = teacher.getByRole('table', { name: '活动成员' });
      for (const [name, role] of [['同学甲', '主负责人'], ['同学乙', '协作者']]) {
        const row = team.getByRole('row').filter({ has: teacher.getByRole('rowheader', { name, exact: true }) });
        await visible(row.getByText(role, { exact: true }));
      }
      await owner.goto(web + '/managed/' + first.id);
      await visible(owner.getByText('交接主负责人', { exact: true }));
      await joined.goto(web + '/mine');
      await visible(joined.getByRole('heading', { name: '同学乙' }));
      assert.equal(await joined.getByRole('link', { name: '活动管理', exact: true }).count(), 0);



    });
    await t.test('老师从学生档案停用甲、核实后恢复，两个原学生窗口均须重新登录', async () => {
      const extra = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
      const second = await extra.newPage();
      second.setDefaultTimeout(8000);
      const loginAgain = async page => {
        await page.getByLabel('账号', { exact: true }).fill('0000000002');
        await page.getByLabel('当前密码').fill(password);
        await button(page, '登录').click();
        await visible(button(page, '退出登录'));
      };
      try {
        await second.goto(web + '/mine');
        await loginAgain(second);
        await teacher.goto(admin + '/manage/students');
        await teacher.setViewportSize({ width: 390, height: 844 });
        await teacher.getByLabel('学号或姓名').fill('0000000002');
        await button(teacher, '查询').click();
        await link(teacher, '核对同学甲的账号').click();
        await button(teacher, '停用账号').click();
        await visible(teacher.getByText('停用账号 · 同学甲（0000000002）'));
        await teacher.getByLabel('办理原因').fill('学生暂离试点');
        await fits(teacher);
        await button(teacher, '确认停用').click();
        await visible(teacher.getByText('学生账号已停用，所有旧会话已撤销。'));
        for (const page of [owner, second]) {
          await page.goto(web + '/mine');
          await visible(button(page, '登录'));
        }
        await button(teacher, '启用账号').click();
        await teacher.getByLabel('办理原因').fill('已核对本期名单');
        assert.equal(await button(teacher, '确认启用').isDisabled(), true);
        await teacher.getByLabel('已核实该学生仍在学院核定试点范围内').check();
        await button(teacher, '确认启用').click();
        await visible(teacher.getByText('学生账号已恢复启用，原会话仍然失效。'));
        await second.reload();
        await visible(button(second, '登录'));
        await loginAgain(owner);
        await link(teacher, '返回学生档案').click();
        await visible(link(teacher, '核对同学甲的账号'));
        assert.equal(await teacher.getByLabel('学号或姓名').inputValue(), '0000000002');
      } finally {
        await teacher.setViewportSize({ width: 1440, height: 900 });
        await extra.close();
      }
    });

    await t.test('老师核对姓名学号并确认本人后重置，负责人旧窗口退出', async () => {
      await teacher.goto(admin + '/manage/accounts');
      await teacher.getByLabel('学生学号').fill('0000000002');
      await button(teacher, '查询账号').click();
      await button(teacher, '重置登录凭证').click();
      await visible(teacher.getByText('重置登录凭证 · 同学甲（0000000002）'));
      const confirmed = teacher.getByLabel('我已人工核验申请人本人，并核对上述账号');
      await teacher.getByLabel('重置原因').fill('本人申请重置');
      assert.equal(await button(teacher, '确认重置').isDisabled(), true);
      await confirmed.check();
      await button(teacher, '确认重置').click();
      await visible(teacher.getByText('旧凭证和登录会话已失效，新凭证待发放。'));
      await visible(teacher.getByText('待发放，暂不可登录'));
      await owner.reload();
      await visible(button(owner, '登录'));
      await owner.getByLabel('账号', { exact: true }).fill('0000000002');
      await owner.getByLabel('当前密码').fill(password);
      await button(owner, '登录').click();
      await visible(owner.getByText(loginFailureMessage, { exact: true }));
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
