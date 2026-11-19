import type { ActivityInput } from '@hongyan/contracts/types';
import type { Actor } from '../auth/session.guard.js';
import { managedScope } from '../activities/read.js';
import type { Tx } from '../activities/workflow.js';
import { invisible } from '../http.js';
import type { HourHistory, PreviewOptions } from './preview.js';
import { previewHourRows } from './preview.js';
import { serviceDate } from './values.js';

type Workbook = Parameters<typeof previewHourRows>[0];
type HistoryReader = (tx: Tx, keys: readonly { student_id: string; service_date: string }[]) => Promise<readonly HourHistory[]>;

export async function previewActivityHours(tx: Tx, actor: Actor, activityId: string, book: Workbook,
  options: PreviewOptions, readHistory: HistoryReader) {
  const activity = await tx.activity.findFirst({
    where: { id: activityId, ...managedScope(actor) },
    select: { activity_code: true, published_revision: true,
      revisions: { where: { revision_state: 'approved' }, select: { revision: true, content: true } } },
  });
  if (!activity) return invisible();
  const numbers = new Set(book.rows.flatMap(({ student_no }) =>
    student_no?.type === 'text' && /^\d{10}$/.test(student_no.value) ? [student_no.value] : []));
  const students = await tx.student.findMany({
    where: { student_no: { in: [...numbers] } },
    select: { id: true, student_no: true, account: { select: { display_name: true } },
      registrations: { where: { activity_id: activityId }, select: { id: true } } },
  });
  const ids = new Map(students.map((student) => [student.student_no, student.id]));
  const keys = new Map<string, { student_id: string; service_date: string }>();
  for (const input of book.rows) {
    const student_id = ids.get(input.student_no?.value ?? '');
    const service_date = serviceDate(input.service_date, book.date_system);
    if (student_id && service_date) keys.set(student_id + '/' + service_date, { student_id, service_date });
  }
  return previewHourRows(book, {
    activity_id: activityId, activity_code: activity.activity_code, published_revision: activity.published_revision,
    approved_schedules: activity.revisions.map(({ revision, content }) =>
      ({ revision, schedule: (content as unknown as ActivityInput).schedule })),
    students: students.map((student) => ({ id: student.id, student_no: student.student_no,
      name: student.account.display_name, registered: student.registrations.length > 0 })),
    history: await readHistory(tx, [...keys.values()]),
  }, options);
}
