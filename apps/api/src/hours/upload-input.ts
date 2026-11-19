import { managedScope } from '../activities/read.js';
import type { Actor } from '../auth/session.guard.js';
import type { Tx } from '../activities/workflow.js';
import { invisible } from '../http.js';
import { parseHourWorkbook } from './workbook.js';

export async function readHourUpload(db: Tx, actor: Actor, activityId: string, filename: string, bytes: Buffer) {
  const activity = await db.activity.findFirst({
    where: { id: activityId, ...managedScope(actor) },
    select: { id: true },
  });
  if (!activity) invisible();
  return parseHourWorkbook(filename, bytes);
}
