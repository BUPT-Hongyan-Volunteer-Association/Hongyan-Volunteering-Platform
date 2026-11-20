import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHourRows } from '../dist/hours/preview.js';
import { serviceDate, hourTenths } from '../dist/hours/values.js';
import { validate } from '../dist/activities/validation.js';

const text = (value) => ({ type: 'text', value });
const number = (value) => ({ type: 'number', value });
const activity = 'P2026-0001', day = '2026-11-18';
const studentId = 'ba070ff7-d528-4f32-a985-61437c773443', recordId = '187733c5-bf5d-436d-80c5-1ae5d9cd725e';
const input = (row_number, overrides = {}) => ({
  row_number, student_no: text('0000000001'), student_name: text('合成学生'), activity_code: text(activity),
  service_date: text(day), credited_hours: number('4'), remark: text('现场说明'), misconduct_reported: text('无'), ...overrides,
});
const schedule = (start, end) => ({ schedule_type: 'continuous', starts_at: start, ends_at: end });
const existing = (overrides = {}) => ({
  id: recordId, version: 3, student_id: studentId, activity_id: 'a', service_date: day, status: 'current',
  hours: '4.0', origin_schedule_revision: 1, misconduct_reported: 'none', misconduct_version: 1, ...overrides,
});
const snapshot = {
  activity_id: 'a', activity_code: activity, published_revision: 1,
  approved_schedules: [{ revision: 1, schedule: schedule(day+'T08:00:00+08:00', day+'T16:00:00+08:00') }],
  students: [{ id: studentId, student_no: '0000000001', name: '合成学生', registered: true }],
  history: [],
};
function preview(rows, data = {}, options = {}) {
  return previewHourRows({ rows, date_system: '1900' }, { ...snapshot, ...data },
    { mode: 'new', now: new Date('2026-11-18T16:00:00Z'), ...options });
}

test('精确解析日期和十分位，不按显示值或二进制浮点近似', () => {
  for (const [raw, expected] of [['0.1',1], ['999.9',9999], ['1.20',12], ['1E-1',1], ['1.25',null],
    ['1.20000000000000001',null], ['-1',null], ['0',null], ['1000',null], ['1E-999999',null]]) {
    assert.equal(hourTenths(number(raw)), expected, raw);
  }
  assert.equal(hourTenths(text('1')), null);
  for (const [raw, system, expected] of [[number('59'),'1900','1900-02-28'],[number('60'),'1900',null],
    [number('61.0'),'1900','1900-03-01'],[number('0'),'1904','1904-01-01'],[number('1.5'),'1904',null],
    [text('2024-02-29'),'1900','2024-02-29'],[text('2026-02-29'),'1900',null]]) {
    assert.equal(serviceDate(raw, system), expected);
  }
});

test('逐字段定位错误；北京午夜跨日，日期不依赖运行机时区', () => {
  const [row] = preview([input(602, { student_no: number('1'), activity_code: text('别的活动'),
    credited_hours: text('1.2'), misconduct_reported: null, service_date: text('2026-11-20') })]).rows;
  assert.equal(row.action, 'error');
  for (const field of ['student_no','activity_code','credited_hours','misconduct_reported','service_date']) {
    assert.ok(row.errors.some((error) => error.row === 602 && error.field === field));
  }
  assert.equal(row.raw_values.credited_hours, '1.2');
  for (const [overrides, field] of [[{student_no:text('0000000009')},'student_no'],[{student_name:text('其他')},'student_name']]) {
    assert.ok(preview([input(2,overrides)]).rows[0].errors.some((error) => error.field === field));
  }
  const tomorrow = input(2,{service_date:text('2026-11-19')});
  const data = {approved_schedules:[{revision:1,schedule:schedule(day+'T23:00:00+08:00','2026-11-19T01:00:00+08:00')}]};
  assert.equal(preview([tomorrow],data).rows[0].action,'add');
  assert.equal(preview([tomorrow],data,{now:new Date('2026-11-18T15:59:59Z')}).rows[0].action,'error');
});

test('全组判重：普通备注忽略，数值等价；不同上报事实/小时/标记全组报错', () => {
  const first = input(2), same = input(804,{credited_hours:number('4.00'),remark:text('普通备注变更')});
  const result = preview([first,same]);
  assert.deepEqual(result.rows.map((row) => row.action),['add','skip_identical']);
  assert.equal(result.projected_delta_hours,'4.0');
  for (const conflicting of [{credited_hours:number('3.9')},{misconduct_reported:text('有')},
    {misconduct_reported:text('有'),remark:text('不同事实')}]) {
    const group = preview([first,same,input(1501,conflicting)]);
    assert.equal(group.error_count,3);
    assert.equal(group.projected_delta_hours,'0.0');
  }
  const reported = (num,remark) => input(num,{misconduct_reported:text('有'),remark:text(remark)});
  assert.equal(preview([reported(2,'甲\r\n乙 '),reported(3,'甲\n乙')]).skipped_count,1);
  assert.equal(preview([reported(2,'甲乙'),reported(3,'甲 乙')]).error_count,2);
});

test('超计划的等价重复行仅在计入时长的行要求说明', () => {
  const data = { approved_schedules: [{ revision: 1, schedule: schedule(day+'T08:00:00+08:00', day+'T12:00:00+08:00') }] };
  const first = input(2, { credited_hours: number('5'), remark: text('延长现场服务') });
  const second = input(3, { credited_hours: number('5'), remark: null });
  const batch = preview([first, second], data);
  assert.deepEqual(batch.rows.map(row => [row.action, row.delta_hours]), [['add', '5.0'], ['skip_identical', '0.0']]);
  assert.deepEqual(batch.warnings.map(w => [w.code, w.row_numbers, w.explanation]),
    [['exceeds_planned_hours', [2], '延长现场服务']]);
  assert.deepEqual([batch.valid_count, batch.skipped_count, batch.error_count, batch.projected_delta_hours], [1, 1, 0, '5.0']);

  const [alone] = preview([second], data).rows;
  assert.equal(alone.action, 'error');
  assert.deepEqual(alone.errors.map(error => error.field), ['remark']);
});

test('同键按首条合格行计时，姓名错误的行保留自己的错误', () => {
  for (const invalidRow of [2, 202]) {
    const rows = [2, 202, 804].map(n => input(n, {
      student_name: text(n === invalidRow ? '姓名不符' : '合成学生'),
      misconduct_reported: text('有'),
    }));
    const batch = preview(rows);
    const [accepted, duplicate] = batch.rows.filter(row => row.row_number !== invalidRow);
    assert.deepEqual(batch.rows.find(row => row.row_number === invalidRow).errors.map(e => e.field), ['student_name']);
    assert.deepEqual([accepted.action, duplicate.action, batch.error_count, batch.projected_delta_hours],
      ['add', 'skip_identical', 1, '4.0']);
    assert.deepEqual(batch.rows.filter(row => row.misconduct_requires_review).map(row => row.row_number),
      [accepted.row_number]);
  }
});

test('同键冲突逐行保留新的违纪事实，已有有效核实结论可复用', () => {
  const rows = [
    input(2),
    input(202, { credited_hours: number('5'), misconduct_reported: text('有'), remark: text('新事实') }),
    input(804, { credited_hours: number('6'), misconduct_reported: text('有'), remark: text('旧事实') }),
  ];
  const batch = preview(rows, { history: [existing({ reusable_facts: ['旧事实'] })] });
  assert.deepEqual(batch.rows.map(row => row.action), ['error', 'error', 'error']);
  assert.deepEqual(batch.rows.filter(row => row.misconduct_requires_review).map(row => row.row_number), [202]);
  assert.equal(batch.misconduct_review_required_count, 1);
  assert.equal(batch.projected_delta_hours, '0.0');
});

test('跨活动 24 小时边界：更正替换旧值；警告缺说明不计有效差额', () => {
  const data = {history:[existing(),existing({id:'b1',activity_id:'b',hours:'18.0'}),
    existing({id:'c1',activity_id:'c',hours:'99.0',status:'voided'})]};
  for (const [hours,delta,warning] of [['6','2.0',false],['7','3.0',true]]) {
    const result = preview([input(5,{credited_hours:number(hours)})],data,{mode:'correction'});
    const [row] = result.rows;
    assert.equal(row.action,'correct');
    assert.equal(row.previous_hours,'4.0');
    assert.equal(result.projected_delta_hours,delta);
    assert.equal(row.warnings.some((w) => w.code === 'daily_total_exceeds_24'),warning);
    if (warning) assert.equal(row.warnings[0].projected_daily_hours,'25.0');
  }
  const missing = preview([input(5,{credited_hours:number('7'),remark:null})],data,{mode:'correction'});
  assert.equal(missing.rows[0].action,'error');
  assert.ok(missing.rows[0].errors.some((error) => error.field === 'remark'));
  assert.equal(missing.projected_delta_hours,'0.0');
});

test('历史获批安排、午夜端点、分钟精度、缺报名说明', () => {
  const schedules = [{revision:1,schedule:schedule(day+'T23:30:00+08:00','2026-11-19T00:00:00+08:00')}];
  const data = {published_revision:2,approved_schedules:schedules};
  assert.equal(preview([input(2)],data).error_count,1);
  const past = preview([input(2,{credited_hours:number('0.5')})],data,{schedule_revision:1});
  assert.equal(past.valid_count,1);
  assert.equal(past.rows[0].warnings.length,0);
  assert.equal(preview([input(2,{service_date:text('2026-11-19')})],data,{schedule_revision:1}).error_count,1);
  const late = preview([input(2,{credited_hours:number('0.6')})],data,{schedule_revision:1});
  assert.equal(late.rows[0].warnings[0].code,'exceeds_planned_hours');
  assert.equal(late.rows[0].warnings[0].planned_hours,'0.5');
  assert.equal(late.rows[0].misconduct_requires_review,false);
  assert.equal(preview([input(2,{remark:null})],{students:[{...snapshot.students[0],registered:false}]}).error_count,1);
});

test('时长精度错误仍能核对历史安排、旧值与独立的违纪上报', () => {
  const rowInput = input(202, {credited_hours:number('1.25'), misconduct_reported:text('有')});
  const history = [existing()];
  const result = preview([rowInput, {...rowInput, row_number:804}], {history}, {mode:'correction'});
  const [first, duplicate] = result.rows;
  assert.equal(first.action, 'error');
  assert.equal(first.bound_schedule_revision, 1);
  assert.equal(first.previous_hours, '4.0');
  assert.equal(first.misconduct_requires_review, true);
  assert.equal(duplicate.action, 'error');
  assert.equal(duplicate.misconduct_requires_review, false);
  assert.equal(result.misconduct_review_required_count, 1);
  assert.equal(result.projected_delta_hours, '0.0');
  assert.equal(first.delta_hours, undefined);
  const reusable = preview([rowInput], {history:[existing({reusable_facts:['现场说明']})]}, {mode:'correction'});
  assert.equal(reusable.rows[0].misconduct_requires_review, false);
  validate('hour_row', JSON.parse(JSON.stringify(first)));
});

test('更正行日期无效也要在同一份报告提示缺少备注', () => {
  const result = preview([input(202, {service_date:text('2026-02-30'), remark:null})], {}, {mode:'correction'});
  const row = result.rows[0];
  assert.deepEqual(row.errors.map(({row, field}) => [row, field]), [[202,'service_date'],[202,'remark']]);
  assert.equal(result.projected_delta_hours, '0.0');
});

test('违纪栏缺值时仍提示可独立判断的时长警告', () => {
  const result = preview([input(8, {credited_hours:number('9'), misconduct_reported:null, remark:null})]);
  const [row] = result.rows;
  assert.equal(row.action, 'error');
  assert.equal(row.warnings[0]?.code, 'exceeds_planned_hours');
  assert.deepEqual(row.errors.map(issue => issue.field), ['misconduct_reported','remark']);
  assert.equal(result.misconduct_review_required_count, 0);
  assert.equal(result.projected_delta_hours, '0.0');
});

test('违纪标记与时长校验独立：有行错误时摘要与待核实筛选一致', () => {
  const result = preview([input(202, { misconduct_reported: text('有'), student_name: text('姓名不符') })]);
  const [row] = result.rows;
  assert.equal(row.action, 'error');
  assert.equal(row.misconduct_requires_review, true);
  assert.equal(result.misconduct_review_required_count, 1);
  assert.equal(result.projected_delta_hours, '0.0');
});

test('库内重复、更正、恢复及仅核实：绑原版本，不因旧六列清除元信息', () => {
  const data = {published_revision:2,history:[existing({misconduct_reported:'reported', misconduct_fact:'说明', reusable_facts:['说明']})]};
  for (const flag of ['not_provided',text('有')]) {
    const row = preview([input(2,{misconduct_reported:flag,remark:text('说明')})],data).rows[0];
    assert.equal(row.action,'skip_identical');
    assert.equal(row.misconduct_requires_review,false);
  }
  const row = preview([input(2,{misconduct_reported:text('有'),remark:text('改变了事实')})],data).rows[0];
  assert.equal(row.action,'review_only');
  assert.equal(row.existing_record_id,recordId);
  assert.equal(row.existing_version,3);
  assert.equal(row.bound_schedule_revision,1);
  assert.equal(row.delta_hours,'0.0');
  assert.equal(row.misconduct_requires_review,true);
  const withoutConclusion = preview([input(2,{misconduct_reported:text('有'),remark:text('说明')})],
    {history:[{...data.history[0],reusable_facts:[]}]}).rows[0];
  assert.equal(withoutConclusion.action,'review_only');
  assert.equal(withoutConclusion.misconduct_requires_review,true);
  assert.equal(preview([input(2,{credited_hours:number('5')})],data).error_count,1);
  const revoked = {history:[existing({status:'voided'})]};
  assert.equal(preview([input(2)],revoked).error_count,1);
  const restored = preview([input(2)],revoked,{mode:'correction'}).rows[0];
  assert.deepEqual([restored.action,restored.previous_hours,restored.delta_hours],['correct','0.0','4.0']);
  assert.equal(preview([input(2)],{}, {mode:'correction'}).error_count,1);
});

test('减少时长为负差额；成功、警告、错误行序列化后符合 OpenAPI', () => {
  const reduced = preview([input(2,{credited_hours:number('1.5')})],{history:[existing()]},{mode:'correction'});
  assert.equal(reduced.projected_delta_hours,'-2.5');
  const examples = [
    ...reduced.rows, ...preview([input(2),input(3)]).rows,
    ...preview([input(8,{credited_hours:number('9')})]).rows,
    ...preview([input(4,{remark:text('长'.repeat(2001))})]).rows,
    ...preview([input(5,{misconduct_reported:text('有')})],{history:[existing()]}).rows,
  ];
  for (const row of examples) validate('hour_row',JSON.parse(JSON.stringify(row)));
});
