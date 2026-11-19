import { randomUUID } from 'node:crypto';
import { Database } from '../dist/database.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = require.resolve('prisma/package.json');
const cli = resolve(dirname(manifest), require(manifest).bin.prisma);

export async function prepareTestDatabase(t, seedEnvironment) {
  const originalUrl = process.env.DATABASE_URL;
  const url = new URL(originalUrl);
  const maintenance = new Database();
  const name = 'hy_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  t.after(async () => {
    process.env.DATABASE_URL = originalUrl;
    try {
      if (created) {
        // 残留连接（例如被中断的客户端）会阻塞 DROP；先结束目标库后端再强制删除。
        await maintenance
          .$executeRawUnsafe(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '" + name + "' AND pid <> pg_backend_pid()",
          )
          .catch(() => {});
        await maintenance.$executeRawUnsafe('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      }
    } finally {
      await maintenance.$disconnect();
    }
  });

  await maintenance.$executeRawUnsafe('CREATE DATABASE ' + name);
  created = true;
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.href;
  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], { stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/seed.mjs'], {
    env: { ...process.env, ...seedEnvironment },
  });
}
