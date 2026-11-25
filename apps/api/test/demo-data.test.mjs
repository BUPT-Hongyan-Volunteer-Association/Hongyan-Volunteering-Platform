import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Database } from '../dist/database.js';
import { demoActivities } from '../scripts/demo-scenarios.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';

test('三项体验活动保留原日期、办理进度和正式入账来源', async (t) => {
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: randomUUID() }, { fullDemo: true });
  const db = new Database();
  try {
    const activities = () => db.activity.findMany({
      orderBy: { activity_code: 'asc' }, include: { revisions: true },
    });
    const rows = await activities();
    assert.deepEqual(rows.map(a => [a.activity_code, a.status, a.revisions[0].content.title]),
      Object.values(demoActivities).map(s => [s.code, s.status, s.title]));
    const [open, pending, completed] = rows;
    const content = open.revisions[0].content;
    assert.ok(Date.parse(content.registration_opens_at) <= Date.now() && Date.now() < Date.parse(content.registration_closes_at));
    assert.equal(pending.published_revision, null);
    const queue = await db.activityReview.findMany({ where: { status: 'pending' } });
    assert.deepEqual(queue.map(r => r.activity_id), [pending.id]);

    const receipt = await db.noticeReceipt.findFirstOrThrow({
      where: { notice: { activity_id: open.id } }, include: { student: true },
    });
    assert.equal(receipt.student.student_no, '0000000004');
    const roster = await db.registration.findMany({ where: { activity_id: open.id } });
    assert.deepEqual(roster.map(r => [r.student_id, r.status]), [[receipt.student_id, 'accepted']]);
    const read = new Date();
    await db.noticeReceipt.update({ where: { notice_id_student_id: {
      notice_id: receipt.notice_id, student_id: receipt.student_id,
    } }, data: { read_at: read, acknowledged_at: read } });

    execFileSync(process.execPath, ['scripts/seed.mjs', '--existing-accounts'], { stdio: 'pipe' });
    assert.deepEqual(await activities(), rows);
    const receipts = await db.noticeReceipt.findMany();
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].acknowledged_at, read);
    assert.equal(await db.hourImportBatch.count(), 1);
    const ledger = await db.hourRecord.findMany({ include: { student: true, source_batch: { include: { rows: true, source: true } } } });
    assert.equal(ledger.length, 1);
    const [record] = ledger;
    assert.deepEqual([record.activity_id, record.student.student_no, record.status, record.hours.toFixed(1)],
      [completed.id, '0000000001', 'current', '2.0']);
    const batch = record.source_batch;
    assert.equal(batch.status, 'approved');
    assert.notEqual(batch.reviewed_by, batch.submitted_by);
    assert.ok(batch.source.contents.length);
    assert.ok(batch.source.created_at <= batch.created_at && batch.created_at <= batch.submitted_at);
    assert.ok(batch.submitted_at <= batch.reviewed_at);
    assert.deepEqual(record.reviewed_at, batch.reviewed_at);
    assert.deepEqual(batch.rows.map(row => [row.row_number, row.action]), [[2, 'add']]);
  } finally {
    await db.$disconnect();
  }
});
