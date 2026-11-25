import { randomUUID } from 'node:crypto';
import { demoActivities } from './demo-scenarios.mjs';
import { content as validateContent } from '../dist/activities/validation.js';
import { includeView } from '../dist/activities/read.js';
import { exportWorkbook } from '../dist/workbook.js';
import { digest } from '../dist/hours/batch-data.js';
import { previewActivityHours } from '../dist/hours/preview-context.js';
import { reviewBatch, submitBatch } from '../dist/hours/batch-review.js';
import { warningSnapshot } from '../dist/hours/warnings.js';
import { beijingDay } from '../dist/hours/values.js';
import { Database } from '../dist/database.js';
import { permanentAdmins } from '../dist/auth/account-access.js';
import { hashPassword } from '../dist/auth/password.js';

const existingAccounts = process.argv.includes('--existing-accounts');
const staffPassword = process.env.DEMO_STAFF_PASSWORD;
if (!existingAccounts && (!staffPassword || staffPassword.length < 12))
  throw Error('请设置至少 12 字符的 DEMO_STAFF_PASSWORD');
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
if (adminPassword && (adminPassword.length < 12 || adminPassword === staffPassword))
  throw Error('技术管理员体验账号需要独立且至少 12 字符的凭证');
const db = new Database();
const people = [
  ['0000000001', '体验学生', ['student']],
  ['0000000002', '同学甲', ['student', 'organizer']],
  ['0000000003', '同学乙', ['student', 'organizer']],
  ['0000000004', '同学丙', ['student', 'organizer']],
  ['demo.teacher', '独立审核员', ['reviewer']],
  ['demo.dual', '兼任审核员', ['reviewer', 'organizer']],
  ...(adminPassword ? [['demo.admin', '合成技术管理员', ['tech_admin']]] : []),
];
const coreOnly = process.argv.includes('--core-activities');
const now = new Date();
const today = Date.parse(beijingDay(now) + 'T00:00:00+08:00');
const day = offset => beijingDay(new Date(today + offset * 86400000));
const at = (offset, time) => new Date(day(offset) + 'T' + time + ':00+08:00');

function activityContent(scene) {
  const d = scene.serviceDay;
  return validateContent({
    title: scene.title, description: scene.description, beneficiaries: '在校师生及访客',
    campus: scene.campus, location: scene.location, meeting_point: scene.meeting_point,
    transport_notes: '请步行至集合地点', capacity: 30,
    registration_opens_at: at(d - 10, '09:00').toISOString(),
    registration_closes_at: at(d - 2, '18:00').toISOString(),
    result_expected_date: day(d - 1),
    schedule: { schedule_type: 'continuous', starts_at: at(d, '09:00').toISOString(), ends_at: at(d, '11:00').toISOString() },
    eligibility_text: '本院学生', selection_text: '负责人核对报名信息后确认',
    expected_hours: '2.0', expected_hours_basis: 'per_occurrence',
    hours_rule_text: '按实际服务和审核结果认定', hours_import_date: day(d + 2),
    contacts: ['志协办公室'], group_join_instructions: '录取后向负责人领取群号',
  }, true);
}

async function acceptedRegistration(tx, activityId, student, ownerId, submittedAt, acceptedAt) {
  await tx.registration.create({ data: {
    activity_id: activityId, student_id: student.id, status: 'accepted', version: 2,
    submitted_at: submittedAt, history: { create: [
      { version: 1, status: 'submitted', submitted_at: submittedAt, changed_at: submittedAt, actor_id: student.account_id },
      { version: 2, status: 'accepted', submitted_at: submittedAt, changed_at: acceptedAt, actor_id: ownerId },
    ] },
  } });
}

async function creditService(tx, activity, student, owner, reviewer, serviceDay) {
  const name = activity.revisions[0].content.title;
  const serviceDate = day(serviceDay);
  const fileName = name + '时长录入.xlsx';
  const contents = exportWorkbook({
    name: '时长录入', headers: ['学号','姓名','活动编号','服务日期','认证时长（小时）','备注','是否有违纪情况'],
    rows: [[student.student_no, student.account.display_name, activity.activity_code, serviceDate, 2, '完成巡查并提交清单', '无']],
  });
  const source = await tx.hourImportFile.create({ data: {
    activity_id: activity.id, name: fileName, purpose: 'hour_import_source', size: contents.length, contents,
  } });
  const submittedAt = new Date();
  const { rows, ...summary } = await previewActivityHours(tx, owner, activity.id, source,
    { mode: 'new', schedule_revision: 1, now: submittedAt });
  if (summary.error_count || summary.valid_count !== 1) throw Error('体验巡查工作簿未通过业务校验');
  const id = randomUUID(), source_hash = digest(contents);
  await tx.hourImportBatch.create({ data: {
    id, activity_id: activity.id, source_file_id: source.id, mode: 'new', status: 'ready',
    submitted_by: owner.account_id, validation_by: owner.account_id, created_at: submittedAt,
    metadata: { activity_title: name, activity_code: activity.activity_code, batch_code: 'H-' + id,
      source_file_name: fileName, source_hash, schedule_revision: 1 },
    summary: { ...summary, ...warningSnapshot(summary.warnings), progress: 100 },
    rows: { create: rows.map(row => ({
      row_number: row.row_number, action: row.action, needs_review: !!row.misconduct_requires_review, detail: row,
    })) },
  } });
  const authorized = (actor, role) => async () => {
    await tx.account.findFirstOrThrow({ where: { id: actor.account_id, active: true,
      roles: { some: { role, OR: [{ expires_at: null }, { expires_at: { gt: now } }] } },
    } });
    return actor;
  };
  const submitted = await submitBatch(tx, activity, id, { expected_version: 1, source_hash }, owner, submittedAt, authorized(owner, 'organizer'));
  await reviewBatch(tx, activity, id, { expected_version: submitted.version,
    decision: 'approved', reason: '已核对巡查清单及两小时服务记录' }, reviewer, new Date(), authorized(reviewer, 'reviewer'));
}

async function initializeAccounts(tx) {
  for (const [username, display_name, roles] of people) {
    const student = roles.includes('student');
    await tx.account.upsert({
      where: { username },
      update: {},
      create: {
        username,
        display_name,
        password_hash: await hashPassword(student ? username.slice(-6) : roles.includes('tech_admin') ? adminPassword : staffPassword),
        must_change_password: student,
        roles: { create: roles.map((role) => ({ role })) },
        ...(student && { student: { create: { student_no: username } } }),
      },
    });
  }
  const admins = await tx.$queryRaw`SELECT EXISTS (SELECT 1 FROM (${permanentAdmins}) admins) AS available`;
  if (!admins[0].available)
    throw Error('建种需要至少一名可登录的长期技术管理员。首次建种请设置独立的 DEMO_ADMIN_PASSWORD，已有同名账号时请核对其状态');
}

try {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hongyan-demo-seed'))`;
      if (!existingAccounts) await initializeAccounts(tx);
      const identities = await tx.account.findMany({
        where: { username: { in: people.map(([username]) => username) } },
        select: { id: true, username: true, display_name: true, roles: { select: { role: true } } },
      });
      const accounts = new Map(identities.map(a => [a.username, {
        account_id: a.id, display_name: a.display_name, roles: a.roles.map(g => g.role),
      }]));
      const teacher = accounts.get('demo.teacher');
      for (const scene of Object.values(demoActivities)) {
        const { status, serviceDay } = scene;
        if (coreOnly && status === 'completed') continue;
        if (await tx.activity.findUnique({ where: { activity_code: scene.code } })) continue;
        const pending = status === 'pending_review';
        const owner = accounts.get(pending ? '0000000003' : '0000000002');
        const members = [{ account_id: owner.account_id, member_role: 'owner' }];
        if (status === 'published') {
          for (const username of ['0000000004', 'demo.dual'])
            members.push({ account_id: accounts.get(username).account_id, member_role: 'collaborator' });
        }
        const created = at(serviceDay - 12, '10:00');
        const approved = at(serviceDay - 11, '10:00');
        const activity = await tx.activity.create({ data: {
          activity_code: scene.code, status, working_revision: 1, published_revision: pending ? null : 1,
          members: { create: members }, revisions: { create: {
            revision: 1, revision_state: pending ? 'pending_review' : 'approved',
            content: activityContent(scene), created_by: owner.account_id,
            created_at: pending ? now : created, approved_at: pending ? null : approved,
          } },
          reviews: { create: { revision: 1, submitted_by: owner.account_id,
            created_at: pending ? now : created, status: pending ? 'pending' : 'approved',
            reviewed_by: pending ? null : teacher.account_id, reviewed_at: pending ? null : approved } },
        }, include: includeView });
        if (pending) continue;
        const source = { activity_id: activity.id, revision: 1 };
        await tx.auditEvent.create({ data: {
          actor_id: teacher.account_id, action: 'review_activity', resource_type: 'activity_review',
          resource_id: activity.reviews[0].id, created_at: approved,
          before: { ...source, status: 'pending', published_revision: null },
          after: { ...source, status: 'approved', published_revision: 1 },
        } });
        const student = await tx.student.findUniqueOrThrow({
          where: { student_no: status === 'completed' ? '0000000001' : '0000000004' }, include: { account: true },
        });
        await acceptedRegistration(tx, activity.id, student, owner.account_id, at(serviceDay - 9, '10:00'), at(serviceDay - 8, '16:00'));
        if (coreOnly) continue;
        if (status === 'completed') await creditService(tx, activity, student, owner, teacher, serviceDay);
        else await tx.notice.create({ data: {
          activity_id: activity.id, title: '读书角整理集合提醒', body: '请在活动室一层大厅集合，向负责人领取书架清单',
          published_by: owner.account_id, notice_kind: 'other', requires_ack: true,
          receipts: { create: { student_id: student.id } },
        } });
      }
    },
    { timeout: 30000 },
  );
  console.log('体验账号与活动已就绪');
} finally {
  await db.$disconnect();
}
