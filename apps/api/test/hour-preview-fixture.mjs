import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { previewActivityHours } from '../dist/hours/preview-context.js';
import { parseHourWorkbook } from '../dist/hours/workbook.js';
import { readHistory } from '../dist/hours/batch-data.js';
import { cell, headers, row, workbook } from './hour-workbook-fixture.mjs';

const date = '2020-11-18', code = 'P2026-0901';

function serviceRow(index, student, value, flag, remark = '已核对现场记录') {
  const values = [student.student_no, student.account.display_name, code, date, value, remark];
  if (flag !== undefined) values.push(flag);
  return row(index, values.map((item, col) => cell(String.fromCharCode(65 + col) + index, item, col === 4 ? 'n' : 'str')).join(''));
}

function mixedWorkbook(students, fixed = false, repeatedRows = 0) {
  const data = serviceRow(2, students[0], '2', '无') + serviceRow(3, students[0], '2', '无')
    + serviceRow(202, students[1], fixed ? '1.2' : '1.25', '无') + serviceRow(804, students[2], '7', '有')
    + Array.from({ length: repeatedRows }, (_, index) => serviceRow(805 + index, students[0], '2', '无')).join('');
  return workbook(data);
}

function legacyWorkbook(students, count) {
  return workbook(Array.from({ length: count }, (_, i) => i === count - 1
    ? serviceRow(i + 2, students[1], '1.2') : serviceRow(i + 2, students[0], '2')).join(''), headers.slice(0, 6));
}

export async function checkHourPreview(db, sample) {
  const students = await db.student.findMany({ include: { account: true }, orderBy: { student_no: 'asc' }, take: 3 });
  const bytes = mixedWorkbook(students);
  const book = await parseHourWorkbook('合成混合预览.xlsx',bytes);
  const activityId = await db.$transaction(async (tx) => {
    const owner = students[1].account_id;
    const future = sample.revisions[0].content;
    const past = { ...future, schedule: { schedule_type:'continuous',starts_at:date+'T08:00:00+08:00',ends_at:date+'T16:00:00+08:00' } };
    const activity = await tx.activity.create({ data: {
      activity_code: code, status:'published', published_revision:2, working_revision:2,
      revisions:{create:[past,future].map((content,index) => ({revision:index+1,revision_state:'approved',content,created_by:owner,approved_at:new Date()}))},
      members:{create:{account_id:owner,member_role:'owner'}},
      registrations:{create:{student_id:students[0].id,status:'accepted'}},
    } });
    const historical = { id:randomUUID(),version:1,activity_id:sample.id,student_id:students[2].id,service_date:new Date(date),
      status:'current',hours:'18.0',origin_schedule_revision:1,misconduct_reported:'none',misconduct_version:0 };
    await tx.hourRecord.create({data:historical});
    const allHistory = () => tx.hourRecord.findMany({orderBy:{id:'asc'}});
    const before = await allHistory();
    const preview = () => previewActivityHours(tx,{account_id:owner,roles:['organizer']},activity.id,book,
      {mode:'new',now:new Date('2026-11-19T01:00:00Z'),schedule_revision:1},readHistory);
    const result = await preview();
    assert.deepEqual(result.rows.map(({row_number,action}) => [row_number,action]),
      [[2,'add'],[3,'skip_identical'],[202,'error'],[804,'add']]);
    assert.equal(result.rows[2].errors[0].field,'credited_hours');
    assert.deepEqual([result.valid_count,result.skipped_count,result.error_count,result.projected_delta_hours],[2,1,1,'9.0']);
    assert.deepEqual(result.warnings.map(({code,projected_daily_hours}) => [code,projected_daily_hours]),[['daily_total_exceeds_24','25.0']]);
    assert.equal(result.rows[3].misconduct_requires_review,true);
    assert.equal(result.rows[3].bound_schedule_revision,1);
    assert.deepEqual(await preview(),result);
    assert.deepEqual(await allHistory(),before);
    return activity.id;
  },{isolationLevel:'RepeatableRead'});
  return { activityId, bytes, fixed:mixedWorkbook(students,true), ownerId:students[1].account_id,
    combinedErrors: () => workbook(serviceRow(202, students[1], '1.25', '有') + serviceRow(804, students[0], '9', '', '')),
    legacyWorkbook: count => legacyWorkbook(students, count),
    paginatedWorkbook: () => mixedWorkbook(students,false,17) };
}
