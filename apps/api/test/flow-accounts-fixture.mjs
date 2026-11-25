import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { browser } from './api-client.mjs';

export async function withFlowAccounts(t, exercise) {
  const staffPassword = randomUUID();
  const adminPassword = randomUUID();
  const ownerPassword = 't1' + randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: staffPassword, DEMO_ADMIN_PASSWORD: adminPassword });
  let app;
  try {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const [student, owner, other, teacher] = Array.from({ length: 4 }, () => browser(base));
    await Promise.all([
      student.signIn('0000000001', '000001', 't1' + randomUUID()),
      owner.signIn('0000000002', '000002', ownerPassword),
      other.signIn('0000000003', '000003', 't1' + randomUUID()),
      teacher.signIn('demo.teacher', staffPassword),
    ]);
    const sample = await db.activity.findUniqueOrThrow({
      where: { activity_code: 'P2026-0001' },
      include: { revisions: true },
    });
    await exercise({ db, base, student, owner, other, teacher, sample, staffPassword, adminPassword, ownerPassword });
  } finally {
    await app?.close();
  }
}
