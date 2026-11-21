import { randomUUID } from 'node:crypto';
import { cell, row, workbook } from './hour-workbook-fixture.mjs';

export function ledgerDay(daysAgo = 2) {
  return new Date(Date.now() + 8 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

export async function ledgerActivity(db, ownerId, title, options = {}) {
  const base = await db.activityRevision.findFirstOrThrow({
    where: { activity: { activity_code: 'P2026-0001' }, revision: 1 },
  });
  return db.activity.create({
    data: {
      activity_code: 'T-' + randomUUID().slice(0, 8), status: 'published', published_revision: 1, working_revision: 1,
      members: { create: { account_id: ownerId, member_role: 'owner' } },
      revisions: { create: { revision: 1, revision_state: 'approved', created_by: ownerId, approved_at: new Date(),
        content: { ...base.content, title,
          schedule: options.schedule ?? { schedule_type: 'date_range', duration_start_date: ledgerDay(20), duration_end_date: ledgerDay(1) },
        },
      } },
    },
  });
}

export function ledgerWorkbook(activity, entries) {
  return workbook(entries.map(({ student, day, hours = '2.0', flag = '无', note = '已核对实际服务', number }, index) => {
    const line = number ?? index + 2;
    return row(line, [student.student_no, student.account.display_name, activity.activity_code, day, hours, note, flag]
      .map((value, col) => cell(String.fromCharCode(65 + col) + line, value, col === 4 ? 'n' : 'str')).join(''));
  }).join(''));
}

export async function seedApprovedHours(db, record, submittedBy) {
  const batch = await db.hourImportBatch.create({ data: { activity_id: record.activity_id, mode: 'new',
    status: 'approved', submitted_by: submittedBy, validation_by: submittedBy, reviewed_at: new Date(),
    metadata: {}, summary: {} } });
  return db.hourRecord.create({ data: { ...record, batch_id: batch.id } });
}
