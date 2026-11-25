import { randomUUID } from 'node:crypto';
import { Database } from '../dist/database.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = require.resolve('prisma/package.json');
const cli = resolve(dirname(manifest), require(manifest).bin.prisma);

export async function prepareTestDatabase(t, seedEnvironment, { fullDemo = false } = {}) {
  const originalUrl = process.env.DATABASE_URL;
  const url = new URL(originalUrl);
  const maintenance = new Database();
  const name = 'hy_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  t.after(async () => {
    process.env.DATABASE_URL = originalUrl;
    try {
      if (created) await maintenance.$executeRawUnsafe('DROP DATABASE ' + name);
    } finally {
      await maintenance.$disconnect();
    }
  });

  await maintenance.$executeRawUnsafe('CREATE DATABASE ' + name);
  created = true;
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.href;
  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], { stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/seed.mjs', ...(fullDemo ? [] : ['--core-activities'])], {
    env: { ...process.env, DEMO_ADMIN_PASSWORD: randomUUID(), ...seedEnvironment },
  });
}
