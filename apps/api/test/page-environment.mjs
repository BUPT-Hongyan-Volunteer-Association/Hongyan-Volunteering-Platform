import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { launchBrowser } from '../scripts/browser.mjs';
import { preview } from 'vite';
import { apiProxy } from '../../../config/vite.shared.ts';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';
import { atTime } from './timeline-fixture.mjs';

import { demoActivities } from '../scripts/demo-scenarios.mjs';

export const shiftDay = (date, days) =>
  new Date(Date.parse(date + 'T00:00:00+08:00') + 8 * 3600_000 + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const loginFailureMessage = '登录失败，请核对账号和密码。如果你刚办理过凭证重置，旧密码已失效，请联系办理老师确认发放进度';
export const lostTeamMessage = '你已不在本活动团队，个人功能不受影响';
export const link = (page, name) => page.getByRole('link', { name, exact: true });
export const button = (page, name) => page.getByRole('button', { name, exact: true });
export const accountSecurity = page => page.getByText('账号安全', { exact: true });
export const visible = (locator) => locator.first().waitFor({ state: 'visible' });

export async function publicSchedulePage(browserPage, date, q, page) {
  const url = new URL('/api/v1/timeline', browserPage.url());
  const monday = shiftDay(date, -((new Date(date).getUTCDay() + 6) % 7));
  url.search = new URLSearchParams({
    scope: 'public', from: atTime(monday, '00:00'), to: atTime(shiftDay(monday, 7), '00:00'),
    q, page: String(page), page_size: '20',
  }).toString();
  const response = await browserPage.request.get(url.href);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
}

export async function openOptions(page, label) {
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
export async function chooseDate(page, label, day) {
  await button(page, label).click();
  const panel = page.locator('.schedule-date-menu:visible');
  await panel.getByLabel('输入日期').fill(day);
  await button(panel, '确定').click();
  await panel.waitFor({ state: 'hidden' });
}

export async function pickOption(page, label, option) {
  const { list } = await openOptions(page, label);
  await list.getByRole('option', { name: option, exact: true }).click();
  await list.waitFor({ state: 'hidden' });
}

export async function signIn(browser, origin, username, password, width,
  initialPassword = username.startsWith('000') ? username.slice(-6) : undefined) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('当前密码').fill(initialPassword ?? password);
  await button(page, '登录').click();
  if (initialPassword) {
    await page.getByLabel('新密码').fill(password);
    await page.getByLabel('当前密码').fill(initialPassword);
    await button(page, '保存新密码').click();
  }
  await visible(button(page, '退出登录'));
  return page;
}

// Hold one real API response until the newer route has finished rendering.
export async function holdResponse(page, pattern, overrides = {}) {
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
export async function settleRender(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

export async function capture(page, name) {
  if (process.env.UI_CAPTURE_DIR) {
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: resolve(process.env.UI_CAPTURE_DIR, name + '.png') });
  }
}

export async function fits(page) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    page.url(),
  );
  const underlined = await page.locator('a[href]:visible').evaluateAll(links =>
    links.filter(link => getComputedStyle(link).textDecorationLine.includes('underline'))
      .map(link => link.innerText.trim()));
  assert.deepEqual(underlined, [], page.url());
}

export async function withPages(t, run) {
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
          proxy: apiProxy(apiOrigin),
        },
      });
      servers.push(server);
    }
    const [web, admin] = servers.map((s) => 'https://127.0.0.1:' + s.httpServer.address().port);
    browser = await launchBrowser({ headless: true });
    const student = await signIn(browser, web, '0000000001', password, 390);
    const owner = await signIn(browser, web, '0000000002', password, 390);
    const joined = await signIn(browser, web, '0000000003', password, 1440);
    const helper = await signIn(browser, web, '0000000004', password, 390);
    const teacher = await signIn(browser, admin, 'demo.teacher', password, 1440);
    const tech = await signIn(browser, admin, 'demo.admin', adminPassword, 1440);
    const db = api.get(Database);
    const first = await db.activity.findUniqueOrThrow({ where: { activity_code: demoActivities.open.code } });
    const firstStart = (
      await db.activityRevision.findFirstOrThrow({
        where: { activity_id: first.id, revision: first.published_revision ?? 1 },
      })
    ).content.schedule.starts_at;
    const firstDate = new Date(Date.parse(firstStart) + 8 * 3600_000).toISOString().slice(0, 10);


    await run({ password, adminPassword, web, admin, api, browser, student, owner, joined, helper, teacher, tech, db, first, firstDate });
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
}
