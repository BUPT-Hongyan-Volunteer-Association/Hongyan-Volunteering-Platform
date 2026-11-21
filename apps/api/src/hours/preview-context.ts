import type { ActivityPublicationContent } from '@hongyan/contracts/types';
import type { Actor } from '../auth/session.guard.js';
import { managedScope } from '../activities/read.js';
import type { Tx } from '../activities/workflow.js';
import { invisible } from '../http.js';
import { previewHourRows, type PreviewOptions } from './preview.js';
import { readHistory, readFactReviews } from './ledger-data.js';
import { parseHourWorkbook } from './workbook.js';
import { serviceDate } from './values.js';

export async function previewActivityHours(
  tx: Tx, actor: Actor, activityId: string,
  source: { name: string; contents: Uint8Array }, options: PreviewOptions,
) {
  const activity = await tx.activity.findFirst({
    where: { id: activityId, ...managedScope(actor) },
    select: { activity_code: true, published_revision: true,
      revisions: { where: { revision_state: 'approved' }, select: { revision: true, content: true } } },
  });
  if (!activity) return invisible();
  const book = await parseHourWorkbook(source.name, Buffer.from(source.contents));
  const numbers = new Set(book.rows.flatMap(({ student_no }) =>
    student_no?.type === 'text' && /^\d{10}$/.test(student_no.value) ? [student_no.value] : []));
  const students = await tx.student.findMany({
    where: { student_no: { in: [...numbers] } },
    select: { id: true, student_no: true, account: { select: { display_name: true } },
      registrations: { where: { activity_id: activityId }, select: {
        submitted_at: true, status: true,
        history: { orderBy: { version: 'asc' }, select: { submitted_at: true, changed_at: true, status: true } },
      } } },
  });
  const ids = new Map(students.map((student) => [student.student_no, student.id]));
  const keys = new Map<string, { student_id: string; service_date: string }>();
  for (const input of book.rows) {
    const student_id = ids.get(input.student_no?.value ?? '');
    const service_date = serviceDate(input.service_date, book.date_system);
    if (student_id && service_date) keys.set(student_id + '/' + service_date, { student_id, service_date });
  }
  const days = [...keys.values()];
  const preview = previewHourRows(book, {
    activity_id: activityId, activity_code: activity.activity_code, published_revision: activity.published_revision,
    approved_schedules: activity.revisions.map(({ revision, content }) =>
      ({ revision, schedule: (content as unknown as ActivityPublicationContent).schedule })),
    students: students.map(({ id, student_no, account, registrations }) => ({
      id, student_no, name: account.display_name,
      registration: registrations[0]?.history.length ? registrations[0].history : registrations,
    })),
    history: await readHistory(tx, days),
    fact_reviews: await readFactReviews(tx, days),
  }, options);
  return { ...preview, template_structure: book.template_structure };
}
