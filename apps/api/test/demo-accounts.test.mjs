import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAccounts } from '../scripts/demo-accounts.mjs';

test('已有体验配置只补缺失管理员，重启保留手动凭证', () => {
  const temp = mkdtempSync(join(tmpdir(), 'demo-accounts-'));
  const dir = pathToFileURL(temp + '/'),
    file = new URL('demo-logins.json', dir);
  try {
    const original = readAccounts(dir, { DEMO_STAFF_PASSWORD: 'teacher-fixture' });
    original['demo.teacher'].password = 'edited-fixture';
    writeFileSync(file, JSON.stringify(original));
    const before = statSync(file);
    const merged = readAccounts(dir, { DEMO_ADMIN_PASSWORD: 'admin-fixture' });
    assert.deepEqual(merged, {
      ...original,
      'demo.admin': { label: '技术管理员', admin: true, password: 'admin-fixture' },
    });
    const after = statSync(file, { bigint: true });
    assert.notEqual(Number(after.ino), before.ino);
    assert.equal(Number(after.mode & 0o777n), 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), merged);
    assert.deepEqual(readAccounts(dir, { DEMO_ADMIN_PASSWORD: 'different' }), merged);
    assert.equal(statSync(file, { bigint: true }).mtimeNs, after.mtimeNs);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
