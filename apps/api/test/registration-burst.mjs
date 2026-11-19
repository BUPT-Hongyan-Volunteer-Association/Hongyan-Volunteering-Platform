import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
import { issueSession } from '../dist/auth/session.service.js';
import { Database } from '../dist/database.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';

// PRD §17. Start from authenticated students, so login traffic is outside the measured window.
const name = 'hy_burst_' + randomUUID().replaceAll('-', '');
const databaseUrl = new URL(process.env.DATABASE_URL);
const maintenance = new Database();
await maintenance.$executeRawUnsafe('CREATE DATABASE ' + name);
let app;
try {
  databaseUrl.pathname = '/' + name;
  process.env.DATABASE_URL = databaseUrl.href;
  prepareTestDatabase({ DEMO_STAFF_PASSWORD: randomUUID() });
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/v1';
  const db = app.get(Database);
  const sample = await db.activity.findUniqueOrThrow({
    where: { activity_code: 'P2026-0001' },
    include: { revisions: true },
  });
  const { content, created_by } = sample.revisions[0];
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const activity = await db.activity.create({
      data: {
        activity_code: 'BURST-' + i,
        status: 'published',
        working_revision: 1,
        published_revision: 1,
        revisions: {
          create: {
            revision: 1,
            revision_state: 'approved',
            approved_at: new Date(),
            content,
            created_by,
          },
        },
        members: { create: { account_id: created_by, member_role: 'owner' } },
      },
    });
    ids.push(activity.id);
  }
  const people = Array.from({ length: 3000 }, (_, i) => {
    const id = randomUUID(),
      username = String(i + 1000).padStart(10, '0');
    return { id, username, session: issueSession(id) };
  });
  await db.account.createMany({
    data: people.map(({ id, username }) => ({
      id,
      username,
      display_name: username,
      password_hash: 'fixture',
      active: true,
      must_change_password: false,
    })),
  });
  await db.student.createMany({
    data: people.map(({ id, username }) => ({ account_id: id, student_no: username })),
  });
  await db.roleGrant.createMany({
    data: people.map(({ id }) => ({ account_id: id, role: 'student' })),
  });
  await db.httpSession.createMany({ data: people.map(({ session }) => session.data) });

  async function send(person, activityId, key) {
    const response = await fetch(base + '/activities/' + activityId + '/registrations', {
      method: 'POST',
      headers: {
        Cookie: 'volunteer_session=' + person.session.value,
        'Content-Type': 'application/json',
        'X-CSRF-Token': person.session.data.csrf_token,
        'Idempotency-Key': key,
      },
      body: '{}',
    });
    const payload = await response.json();
    assert.equal(response.status, 201, payload.code);
    assert.equal(payload.data.status, 'submitted');
    return payload;
  }

  const durations = [],
    errors = new Map(),
    requests = [],
    replay = [];
  const start = performance.now();
  for (let i = 0; i < 12000; i++) {
    const due = start + i * 5;
    const remaining = due - performance.now();
    if (remaining > 0) await delay(remaining);
    const sent = performance.now(),
      person = people[Math.floor(i / 4)],
      id = ids[i % 4],
      key = randomUUID();
    requests.push(
      send(person, id, key)
        .then((payload) => {
          durations.push(performance.now() - sent);
          if (i < 100) replay.push({ person, id, key, payload });
        })
        .catch((e) => errors.set(e.message, 1 + (errors.get(e.message) ?? 0))),
    );
  }
  const sentSeconds = (performance.now() - start) / 1000;
  await Promise.all(requests);
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  const persisted = await db.registration.count({ where: { activity_id: { in: ids } } });
  console.log(
    JSON.stringify({
      students: people.length,
      activities: ids.length,
      requests: requests.length,
      sentSeconds,
      success: durations.length,
      errors: Object.fromEntries(errors),
      p95Milliseconds: p95,
      persisted,
    }),
  );
  assert.equal(durations.length, requests.length);
  assert.equal(persisted, 12000);
  assert.ok(p95 <= 3000);
  for (const entry of replay)
    assert.deepEqual(await send(entry.person, entry.id, entry.key), entry.payload);
  const afterReplay = await db.registration.count({ where: { activity_id: { in: ids } } });
  assert.equal(afterReplay, persisted);
  console.log('独立回放 ' + replay.length + ' 次，记录总数 ' + afterReplay + '。');
} finally {
  try {
    await app?.close();
  } finally {
    try {
      await maintenance.$executeRawUnsafe('DROP DATABASE ' + name);
    } finally {
      await maintenance.$disconnect();
    }
  }
}
