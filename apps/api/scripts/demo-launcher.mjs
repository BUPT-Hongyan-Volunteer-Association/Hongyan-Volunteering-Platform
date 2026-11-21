import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';
import { readAccounts } from './demo-accounts.mjs';

const accounts = readAccounts(new URL('../../../.local/', import.meta.url), process.env);
const port = Number(process.env.DEMO_LAUNCHER_PORT || 5180);
const origin = 'http://127.0.0.1:' + port;
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
class EntryError extends Error {}
let launching;
const template = readFileSync(new URL('./demo-entry.html', import.meta.url), 'utf8');
const groups = [
  {
    id: 'student',
    name: '学生端',
    detail: '活动发现、报名与个人记录',
    icon: '<circle cx="12" cy="8" r="3.5"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  },
  {
    id: 'organizer',
    name: '活动负责人',
    detail: '管理活动、创建活动及查看日程',
    icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h3"/>',
  },
  {
    id: 'admin',
    name: '审核后台',
    detail: '审核队列、学生档案与权限',
    icon: '<path d="M8 5H5v16h14V5h-3"/><rect x="8" y="3" width="8" height="4" rx="1"/><path d="m8 14 3 3 5-6"/>',
  },
];
const seededOrganizers = new Set(['0000000002', '0000000003', '0000000004']);
const lists = groups
  .map((group) => {
    const entries = Object.entries(accounts).filter(([id, a]) => {
      const area = a.admin
        ? 'admin'
        : a.area === 'organizer' || seededOrganizers.has(id)
          ? 'organizer'
          : 'student';
      return area === group.id;
    });
    if (!entries.length) return '';
    const buttons = entries
      .map(
        ([id, a]) =>
          '<button name="account" value="' +
          escapeHtml(id) +
          '"><span><strong>' +
          escapeHtml(a.label) +
          '</strong><small>' +
          escapeHtml(id) +
          '</small></span><i class="arrow" aria-hidden="true"></i></button>',
      )
      .join('');
    return (
      '<section><div class="area-head"><svg viewBox="0 0 24 24" aria-hidden="true">' +
      group.icon +
      '</svg><h2>' +
      group.name +
      '</h2></div><p class="area-desc">' +
      group.detail +
      '</p>' +
      buttons +
      '</section>'
    );
  })
  .join('');
const page = template.replace('<!-- accounts -->', () => lists);
function render(message = '') {
  return page.replace('<!-- feedback -->', () =>
    message ? '<p role="alert">' + escapeHtml(message) + '</p>' : '',
  );
}

async function maximizeWindow(tab) {
  const context = tab.context();
  if (context.browser().browserType().name() !== 'chromium') return;
  const session = await context.newCDPSession(tab);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } finally {
    await session.detach();
  }
}

async function enter(id, account) {
  launching ??= launchBrowser({ headless: false })
    .then((browser) => {
      browser.once('disconnected', () => {
        launching = undefined;
      });
      return browser;
    })
    .catch((error) => {
      launching = undefined;
      throw error;
    });
  const browser = await launching;
  const https = process.env.HY_LOCAL_HTTPS === '1';
  if (!https && browser.browserType().name() === 'webkit')
    throw new EntryError('WebKit 登录需要 HTTPS。请按 README 在 HTTPS 模式下启动两个前端和体验入口。');
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: https });
  const base = (https ? 'https' : 'http') + '://localhost:' + (account.admin ? 5174 : 5173);
  try {
    const client = context.request;
    const csrf = async () =>
      (await (await client.get(base + '/api/v1/auth/csrf')).json()).data.csrf_token;
    const post = async (path, data) =>
      client.post(base + '/api/v1/auth/' + path, {
        headers: { 'X-CSRF-Token': await csrf() },
        data,
      });
    let result = await post('login', {
      username: id,
      password: account.password,
    });
    if (result.status() === 401 && !account.admin)
      result = await post('login', { username: id, password: id.slice(-6) });
    if (!result.ok()) throw new EntryError('登录未通过，请核对本地体验凭证。');
    if ((await result.json()).data.must_change_password) {
      result = await post('change-password', {
        current_password: id.slice(-6),
        new_password: account.password,
      });
      if (!result.ok()) throw new EntryError('首次改密未完成。');
    }
    const profile = await client.get(base + '/api/v1/me');
    if (!profile.ok() || (await profile.json()).data.username !== id)
      throw new EntryError('身份验证失败');
    const tab = await context.newPage();
    await tab.goto(base);
    await tab.getByRole('button', { name: '退出登录' }).waitFor();
    tab.on('close', () => context.close().catch(() => {}));
    await tab.bringToFront();
    await maximizeWindow(tab).catch(() => {
      console.warn('浏览器未能自动最大化，可手动调整体验窗口大小。');
    });
  } catch (e) {
    await context.close();
    throw e;
  }
}
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.headers.host !== '127.0.0.1:' + port || req.url !== '/') {
    res.writeHead(404).end();
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(render());
    return;
  }
  if (req.method !== 'POST' || req.headers.origin !== origin) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100) throw new EntryError('请求无效');
    }
    const id = new URLSearchParams(body).get('account');
    if (!Object.hasOwn(accounts, id)) throw new EntryError('身份无效');
    await enter(id, accounts[id]);
    res.writeHead(303, { Location: '/' }).end();
  } catch (e) {
    const message =
      e instanceof EntryError
        ? e.message
        : '体验窗口未能打开，请检查 README 中的浏览器配置及本地服务后重试。';
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(render(message));
  }
}).listen(port, '127.0.0.1', () => console.log('本地测试入口 ' + origin));
