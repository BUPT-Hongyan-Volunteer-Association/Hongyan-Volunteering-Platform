import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const directory = new URL('../../../.local/', import.meta.url);
const config = new URL('demo-logins.json', directory);
function readAccounts() {
  try {
    return JSON.parse(readFileSync(config, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staff = process.env.DEMO_STAFF_PASSWORD;
  if (!staff)
    throw Error('请设置建种时使用的 DEMO_STAFF_PASSWORD 后重新启动。');
  const accounts = {};
  for (const [i, label] of [
    '体验学生',
    '甲负责人',
    '乙负责人',
    '活动协作者',
  ].entries())
    accounts[String(i + 1).padStart(10, '0')] = {
      label,
      admin: false,
      password: 'T1' + randomUUID(),
    };
  accounts['demo.teacher'] = {
    label: '老师审核员',
    admin: true,
    password: staff,
  };
  accounts['demo.dual'] = { label: '兼任审核员', admin: true, password: staff };
  if (process.env.DEMO_ADMIN_PASSWORD)
    accounts['demo.admin'] = {
      label: '技术管理员',
      admin: true,
      password: process.env.DEMO_ADMIN_PASSWORD,
    };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify(accounts, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  return accounts;
}
const accounts = readAccounts();
const port = Number(process.env.DEMO_LAUNCHER_PORT || 5180);
const origin = 'http://127.0.0.1:' + port;
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
let browser;
const page =
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>鸿雁本地测试</title><style>body{font:18px system-ui;max-width:38rem;margin:8vh auto;padding:20px;color:#17243a}button{padding:12px;margin:5px;border:1px solid #bdcbe2;border-radius:6px;background:white;color:#003399;cursor:pointer}</style><h1>选择测试身份</h1><p>每次在独立 Chrome 窗口打开，可同时验证多个身份。</p><form method="post">' +
  Object.entries(accounts)
    .map(
      ([id, a]) =>
        '<button name="account" value="' +
        escapeHtml(id) +
        '">' +
        escapeHtml(a.label) +
        '</button>',
    )
    .join('') +
  '</form></html>';

async function enter(id, account) {
  if (!browser?.isConnected())
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext();
  const base = account.admin
    ? 'http://localhost:5174'
    : 'http://localhost:5173';
  try {
    const client = context.request;
    const csrf = async () =>
      (await (await client.get(base + '/api/v1/auth/csrf')).json()).data
        .csrf_token;
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
    if (!result.ok()) throw Error('登录未通过，请核对本地体验凭证。');
    if ((await result.json()).data.must_change_password) {
      result = await post('change-password', {
        current_password: id.slice(-6),
        new_password: account.password,
      });
      if (!result.ok()) throw Error('首次改密未完成。');
    }
    const profile = await client.get(base + '/api/v1/me');
    if (!profile.ok() || (await profile.json()).data.username !== id)
      throw Error('身份验证失败');
    const tab = await context.newPage();
    await tab.goto(base);
    await tab.getByRole('button', { name: '退出登录' }).waitFor();
    tab.on('close', () => context.close().catch(() => {}));
    await tab.bringToFront();
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
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(page);
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
      if (body.length > 100) throw Error('请求无效');
    }
    const id = new URLSearchParams(body).get('account');
    if (!Object.hasOwn(accounts, id)) throw Error('身份无效');
    await enter(id, accounts[id]);
    res.writeHead(303, { Location: '/' }).end();
  } catch (e) {
    res
      .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(e.message);
  }
}).listen(port, '127.0.0.1', () => console.log('本地测试入口 ' + origin));
