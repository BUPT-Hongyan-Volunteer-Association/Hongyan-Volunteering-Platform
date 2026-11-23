import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
export function readAccounts(directory, env) {
  const config = new URL('demo-logins.json', directory);
  let accounts;
  try {
    accounts = JSON.parse(readFileSync(config, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existing = accounts !== undefined;
  if (existing && (!env.DEMO_ADMIN_PASSWORD || Object.hasOwn(accounts, 'demo.admin')))
    return accounts;
  if (!existing) accounts = initialAccounts(env);
  if (env.DEMO_ADMIN_PASSWORD)
    accounts['demo.admin'] = {
      label: '技术管理员',
      admin: true,
      password: env.DEMO_ADMIN_PASSWORD,
    };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = new URL('demo-logins.' + randomUUID() + '.tmp', directory);
  try {
    writeFileSync(temporary, JSON.stringify(accounts, null, 2), { mode: 0o600, flag: 'wx' });
    if (existing) renameSync(temporary, config);
    else linkSync(temporary, config);
  } finally {
    rmSync(temporary, { force: true });
  }
  return accounts;
}
function initialAccounts(env) {
  const staff = env.DEMO_STAFF_PASSWORD;
  if (!staff) throw Error('请设置建种时使用的 DEMO_STAFF_PASSWORD 后重新启动。');
  const accounts = {};
  for (const [i, label] of ['体验学生', '同学甲', '同学乙', '同学丙'].entries())
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
  return accounts;
}
