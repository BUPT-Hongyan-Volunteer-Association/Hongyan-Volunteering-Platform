import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';

const link = (page, name) => page.getByRole('link', { name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const visible = (locator) => locator.first().waitFor({ state: 'visible' });

async function signIn(browser, origin, username, password, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
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

async function fits(page) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    page.url(),
  );
}

test('批次 02 三端页面与真实发布流程', { timeout: 180000 }, async (t) => {
  const source = new URL(process.env.DATABASE_URL);
  const maintenance = new Database();
  const name = 'hy_pages_' + randomUUID().replaceAll('-', '');
  const servers = [];
  let api, browser;
  await maintenance.$executeRawUnsafe('CREATE DATABASE ' + name);
  try {
    source.pathname = '/' + name;
    process.env.DATABASE_URL = source.href;
    const password = 'T1' + randomUUID();
    const adminPassword = 'A2' + randomUUID();
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/seed.mjs'], {
      env: { ...process.env, DEMO_STAFF_PASSWORD: password, DEMO_ADMIN_PASSWORD: adminPassword },
    });
    api = await createApp();
    await api.listen(0, '127.0.0.1');
    const apiOrigin = await api.getUrl();
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
    const [web, admin] = servers.map((s) => 'http://127.0.0.1:' + s.httpServer.address().port);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
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
        await owner.goto(web);
        await link(owner, '我的').click();
        await link(owner, '活动管理').click();
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
          await link(owner, tab).click();
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
      await student.getByLabel('查看日期').fill('2026-11-21');
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

    await t.test('学生活动、名单、回执和账号的示例不会发送业务写请求', async () => {
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      for (const p of [student, owner, tech]) p.on('request', collect);
      assert.equal(await button(student, '申请报名').isEnabled(), false);
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
      await tech.getByLabel('操作', { exact: true }).selectOption('停用独立后台账号');
      await button(tech, '预览操作').click();
      await visible(tech.getByText(/停用独立后台账号尚未提交/));
      assert.deepEqual(writes, []);
      for (const p of [student, owner, tech]) p.off('request', collect);
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
      await helper.goto(web + '/managed/' + first.id + '/roster');
      await helper.getByLabel('选择本页').check();
      await link(helper, '返回我的管理活动').click();
      await link(helper, '校园服务乙').click();
      await link(helper, '报名名单').click();
      await visible(helper.getByText(/已选 0 人/));
      await db.activityMember.delete({
        where: { activity_id_account_id: { activity_id: second.id, account_id: account.id } },
      });
      await helper.evaluate(() => window.dispatchEvent(new Event('focus')));
      await visible(helper.getByRole('alert'));
      assert.equal(await helper.getByLabel('选择本页').count(), 0);
      await student.goto(web + '/managed/' + first.id + '/roster');
      await visible(student.getByText('当前账号无活动管理权限。'));
      await student.goto(admin);
      await visible(student.getByText('当前账号无后台权限。'));
      await teacher.goto(web + '/mine/feedback');
      await visible(teacher.getByText('当前账号无学生个人页面权限。'));
    });
  } finally {
    try {
      await browser?.close();
      for (const server of servers) await server.close();
      await api?.close();
    } finally {
      try {
        await maintenance.$executeRawUnsafe('DROP DATABASE ' + name);
      } finally {
        await maintenance.$disconnect();
      }
    }
  }
});
