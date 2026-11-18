import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = require.resolve('prisma/package.json');
const cli = resolve(dirname(manifest), require(manifest).bin.prisma);

export function prepareTestDatabase(seedEnvironment) {
  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], { stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/seed.mjs'], {
    env: { ...process.env, ...seedEnvironment },
  });
}
