import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type {
  ActivityInput,
  Attendance,
  AttendanceBatchInput,
  AttendanceInput,
  VersionAction,
} from '@hongyan/contracts/types';
import { workspaceScope, pagination, publishedRevision, type LoadedActivity } from '../activities/read.js';
import { parseCalendarDate, serviceDayMilliseconds, slots } from '../activities/schedule.js';
import { validate } from '../activities/validation.js';
import { checkVersion, Workflow, type Tx } from '../activities/workflow.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { Database } from '../database.js';
import type { AttendanceRecord } from '../generated/prisma/client.js';
import { BusinessError, envelope, invalid, invisible } from '../http.js';

const studentFields = {
  id: true,
  student_no: true,
  account: { select: { display_name: true } },
} as const;
const includeStudent = { student: { select: studentFields } } as const;

function dateOnly(value: string): Date {
  return parseCalendarDate(value) ?? invalid('service_date', '请选择有效的服务日期');
}

function checkSchedule(activity: LoadedActivity, day: string) {
  const approved = publishedRevision(activity);
  const schedule = (approved?.content as unknown as ActivityInput | undefined)?.schedule;
  if (!(serviceDayMilliseconds(slots(schedule), day) > 0))
    invalid('service_date', '请选择活动获批安排内的服务日期');
}

function exceptionFields({ status, reason }: Pick<AttendanceInput, 'status' | 'reason'>) {
  const note = reason?.trim() || null;
  if (!note && (status === 'other' || status === 'unregistered_participation'))
    invalid('reason', '请填写具体的异常原因');
  return { status, reason: note };
}

function view({ student, cleared_at, ...row }: AttendanceRecord & {
  student: { student_no: string; account: { display_name: string } };
}): Attendance {
  const { service_date, created_at, updated_at, reason, ...fields } = row;
  return {
    ...fields,
    student_no: student.student_no,
    student_name: student.account.display_name,
    service_date: service_date.toISOString().slice(0, 10),
    created_at: created_at.toISOString(),
    updated_at: updated_at.toISOString(),
    ...(reason && { reason }),
  };
}

async function batchStudents(tx: Tx, activity_id: string, input: AttendanceBatchInput) {
  if (input.status === 'unregistered_participation') {
    if (!input.unregistered_students) invalid('unregistered_students', '请填写完整学号及姓名');
    const students = await tx.student.findMany({
      where: {
        registrations: { none: { activity_id } },
        OR: input.unregistered_students.map(({ student_no, student_name }) => ({
          student_no,
          account: { display_name: student_name.trim() },
        })),
      },
      select: studentFields,
    });
    const names = new Map(students.map((student) => [student.student_no, student.account.display_name]));
    const mismatches = input.unregistered_students.flatMap(({ student_no, student_name }, index) =>
      names.get(student_no) === student_name.trim() ? [] : [index + 1],
    );
    if (mismatches.length)
      invalid('unregistered_students', '第 ' + mismatches.join('、') + ' 位人员的学号和姓名与档案不符，或已在报名名单中');
    if (students.length !== input.unregistered_students.length)
      invalid('unregistered_students', '同一学号只需填写一次');
    return students;
  }
  if (!input.student_ids) invalid('student_ids', '请从本活动报名名单选择人员');
  const students = await tx.student.findMany({
    where: { id: { in: input.student_ids }, registrations: { some: { activity_id } } },
    select: studentFields,
  });
  if (students.length !== input.student_ids.length)
    invalid('student_ids', '请重新核对活动报名名单及已选人员');
  return students;
}

@Controller('organizer/activities/:id/attendance')
export class AttendanceController {
  constructor(private db: Database, private workflow: Workflow) {}

  @Get()
  list(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) activity_id: string,
    @Query() query: Record<string, string>,
  ) {
    const scope = workspaceScope(req.actor, query.scope);
    return this.db.$transaction(async (tx) => {
      if (!await tx.activity.findFirst({ where: { id: activity_id, ...scope }, select: { id: true } }))
        invisible();
      const { page, page_size, skip } = pagination(query);
      const where = {
        activity_id,
        cleared_at: null,
        service_date: query.service_date === undefined ? undefined : dateOnly(query.service_date),
      };
      const total = await tx.attendanceRecord.count({ where });
      const rows = skip < total ? await tx.attendanceRecord.findMany({
        where,
        orderBy: [{ service_date: 'desc' }, { student_id: 'asc' }],
        skip,
        take: page_size,
        include: includeStudent,
      }) : [];
      return envelope({ page, page_size, total, items: rows.map(view) });
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Post()
  recordBatch(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) activity_id: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.workflow.run(req, { activityId: activity_id }, 'workspace', async (tx, activity) => {
      const input = validate<AttendanceBatchInput>('attendance_batch_input', body);
      const service_date = dateOnly(input.service_date);
      checkSchedule(activity!, input.service_date);
      const fields = exceptionFields(input);
      const students = await batchStudents(tx, activity_id, input);
      const where = { activity_id, service_date, student_id: { in: students.map((s) => s.id) } };
      const existing = await tx.attendanceRecord.findMany({ where, select: { student_id: true, cleared_at: true } });
      const duplicate = existing.find((row) => row.cleared_at === null);
      if (duplicate) {
        const name = students.find((s) => s.id === duplicate.student_id)!.account.display_name;
        throw new BusinessError(409, 'attendance_already_recorded', name + '当日已有记录，请在列表中核对');
      }
      const stored = new Set(existing.map((row) => row.student_id));
      const fresh = students.filter((s) => !stored.has(s.id));
      if (fresh.length) await tx.attendanceRecord.createMany({
        data: fresh.map(({ id: student_id }) => ({ activity_id, student_id, service_date, ...fields })),
      });
      if (stored.size) await tx.attendanceRecord.updateMany({
        where: { ...where, cleared_at: { not: null } },
        data: { ...fields, version: { increment: 1 }, cleared_at: null },
      });
      return { recorded_count: students.length };
    }, scope);
  }

  @Put(':student_id/:day')
  record(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) activity_id: string,
    @Param('student_id', ParseUUIDPipe) student_id: string,
    @Param('day') day: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.workflow.run(req, { activityId: activity_id }, 'workspace', async (tx, activity) => {
      const input = validate<AttendanceInput>('attendance_input', body);
      const fields = exceptionFields(input);
      const key = { activity_id, student_id, service_date: dateOnly(day) };
      const where = { activity_id_student_id_service_date: key };
      const existing = await tx.attendanceRecord.findUnique({ where });
      const active = existing?.cleared_at === null ? existing : undefined;
      checkVersion(active?.version ?? 0, input.expected_version);
      const unregistered = input.status === 'unregistered_participation';
      if (unregistered !== (active?.status === 'unregistered_participation'))
        invalid('status', '未报名参加须按学号及姓名单独补录');
      if (!active) {
        checkSchedule(activity!, day);
        const registration = await tx.registration.findUnique({
          where: { activity_id_student_id: { activity_id, student_id } },
          select: { id: true },
        });
        if (!registration) invisible();
      }
      return view(await tx.attendanceRecord.upsert({
        where,
        create: { ...key, ...fields },
        update: { ...fields, version: { increment: 1 }, cleared_at: null },
        include: includeStudent,
      }));
    }, scope);
  }

  @Delete(':student_id/:day')
  withdraw(
    @Req() req: SessionRequest,
    @Param('id', ParseUUIDPipe) activity_id: string,
    @Param('student_id', ParseUUIDPipe) student_id: string,
    @Param('day') day: string,
    @Body() body: unknown,
    @Query('scope') scope?: string,
  ) {
    return this.workflow.run(req, { activityId: activity_id }, 'workspace', async (tx) => {
      const { expected_version } = validate<VersionAction>('version_action', body);
      const where = { activity_id_student_id_service_date: { activity_id, student_id, service_date: dateOnly(day) } };
      const current = await tx.attendanceRecord.findUnique({ where });
      checkVersion(current?.cleared_at === null ? current.version : 0, expected_version);
      const row = await tx.attendanceRecord.update({
        where,
        data: { cleared_at: new Date(), version: { increment: 1 } },
      });
      return { completed: true, resource_id: row.id, version: row.version };
    }, scope);
  }
}
