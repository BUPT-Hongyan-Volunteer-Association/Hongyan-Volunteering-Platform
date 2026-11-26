import type { StudentPatch } from '@hongyan/contracts/types';
import { checkVersion, invalid } from '../http.js';
import { type Tx } from '../database.js';
import { audit } from '../audit.js';
import { guardPermanentAdminLoss } from '../auth/account-access.js';
import type { Actor } from '../auth/session.guard.js';

export function studentView(student: {
  id: string;
  version: number;
  student_no: string;
  cohort: string | null;
  grade: string | null;
  class_name: string | null;
  college: string | null;
  created_at: Date;
  updated_at: Date;
  account_id: string;
  account: { display_name: string; active: boolean };
}) {
  return {
    id: student.id,
    version: student.version,
    created_at: student.created_at.toISOString(),
    updated_at: student.updated_at.toISOString(),
    student_no: student.student_no,
    name: student.account.display_name,
    ...(student.cohort?.trim() && { cohort: student.cohort }),
    ...(student.grade && { grade: student.grade }),
    ...(student.class_name && { class_name: student.class_name }),
    ...(student.college && { college: student.college }),
    status: student.account.active ? ('active' as const) : ('inactive' as const),
    account_id: student.account_id,
  };
}

const profileFields = ['cohort', 'grade', 'class_name', 'college'] as const;

export async function updateStudent(tx: Tx, id: string, actor: Actor, input: StudentPatch) {
  const include = { account: { select: { display_name: true, active: true } } } as const;
  const row = await tx.student.findUniqueOrThrow({ where: { id }, include });
  checkVersion(row.version, input.expected_version);
  const reason = input.reason.trim();
  if (!reason) invalid('reason', '请填写办理原因');
  const name = input.name?.trim();
  if (name === '') invalid('name', '姓名不能为空');
  const grade = input.grade?.trim();
  if (grade && !/^\d{4}$/.test(grade)) invalid('grade', '年级须为四位年份');
  const active = input.status === undefined ? row.account.active : input.status === 'active';
  const statusChanged = active !== row.account.active;
  if (statusChanged && active && input.pilot_scope_verified !== true)
    invalid('pilot_scope_verified', '恢复前请核实学生仍在学院核定试点范围');

  const profile: Partial<Record<typeof profileFields[number], string | null>> = {};
  for (const key of profileFields) {
    if (input[key] === undefined) continue;
    const next = input[key].trim() || null;
    if (row[key] !== next) profile[key] = next;
  }
  const nameChanged = name !== undefined && name !== row.account.display_name;
  if (!statusChanged && !nameChanged && !Object.keys(profile).length) return studentView(row);

  if (statusChanged && !active) await guardPermanentAdminLoss(tx, row.account_id);
  if (statusChanged || nameChanged) {
    await tx.account.update({ where: { id: row.account_id }, data: {
      ...(statusChanged && { active }), ...(nameChanged && { display_name: name }), version: { increment: 1 },
    } });
  }
  if (statusChanged && !active) {
    await tx.httpSession.deleteMany({ where: { account_id: row.account_id } });
  }
  const next = await tx.student.update({ where: { id }, data: { ...profile, version: { increment: 1 } }, include });
  // Record only fields involved in this change. Mask identifying name and class values.
  const snapshot = (record: typeof row) => {
    const fields: Record<string, unknown> = { version: record.version };
    if (statusChanged) fields.status = record.account.active ? 'active' : 'inactive';
    if (nameChanged) fields.name = record.account.display_name.slice(0, 1) + '＊';
    for (const key of profileFields) {
      if (!(key in profile)) continue;
      const value = record[key];
      fields[key] = key === 'class_name' && value ? '******' + value.slice(-4) : value;
    }
    return fields;
  };
  await audit(tx, { actor_id: actor.account_id, resource_type: 'student', resource_id: id,
    action: 'update_student', reason, before: snapshot(row),
    after: { ...snapshot(next), ...(statusChanged && active && { pilot_scope_verified: true }) } });
  return studentView(next);
}
