import { browser } from './api-client.mjs';
import { pollUntil } from './poll-until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { scan, attr } from '../dist/ooxml.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { buildWorkbook, rosterSheet } from './xlsx-fixture.mjs';

const template = readFileSync(
  new URL('../../../packages/contracts/templates/学生建档导入模板_v1.5.xlsx', import.meta.url),
);

test('下载模板的输入校验与五列表头对齐', () => {
  const xml = strFromU8(unzipSync(template)['xl/worksheets/sheet1.xml']);
  const validationTitles = {};
  scan(xml, { open(tag) {
    if (tag.local === 'dataValidation') validationTitles[attr(tag, 'sqref')] = attr(tag, 'errorTitle');
  } });
  assert.deepEqual(validationTitles, {
    'A2:A5001': '十位数字学号', 'B2:B5001': '姓名', 'C2:C5001': '年级',
    'D2:D5001': '十位数字班级', 'E2:E5001': '学院',
  });
});

async function waitImport(client, id) {
  return pollUntil(async () => {
    const response = await client.request('/admin/student-imports/' + id);
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.data;
  }, batch => batch.status !== 'validating', '学生建档');
}

async function uploadImport(client, workbook, filename = '名单.xlsx') {
  const response = await client.upload('/admin/student-imports', workbook, filename);
  assert.equal(response.status, 202, JSON.stringify(response));
  return waitImport(client, response.data.id);
}

const workbook = (rows, options = {}) =>
  buildWorkbook({ sheets: [rosterSheet(rows, options)], prefix: true, sharedStrings: true });
const num = (value) => ({ n: String(value) });
const formula = (value, result) => ({ f: value, v: result });

const commitBody = (batch) => ({
  expected_version: batch.version,
  source_hash: batch.source_hash,
});

test('学生名单导入校验、预览、确认与首次登录在真实 PostgreSQL 上保持一致', async (t) => {
  const staffPassword = randomUUID();
  const adminPassword = randomUUID();
  await prepareTestDatabase(t, {
    DEMO_STAFF_PASSWORD: staffPassword,
    DEMO_ADMIN_PASSWORD: adminPassword,
  });
  let app;
  try {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const teacher = browser(base);
    const student = browser(base);
    await teacher.signIn('demo.teacher', staffPassword);
    await student.signIn('0000000001', '000001', 'student-new-pass1');
    const upload = (bytes, filename) => teacher.upload('/admin/student-imports', bytes, filename);

    await t.test('上传限 5 MB，只接受 v1.5 模板的工作表与必需表头', async () => {
      const oversized = Buffer.alloc(5_242_881);
      oversized[0] = 0x50;
      oversized[1] = 0x4b;
      let response = await upload(oversized);
      assert.equal(response.status, 422);
      assert.equal(response.code, 'validation_error');
      assert.equal(response.details[0].field, 'file');

      response = await teacher.upload('/admin/student-imports', workbook([]), '名单.csv');
      assert.equal(response.status, 422);

      response = await teacher.upload('/admin/student-imports', Buffer.from('not a workbook'), '名单.xlsx');
      assert.equal(response.status, 422);

      const huge = Buffer.alloc(6_500_000);
      huge[0] = 0x50;
      huge[1] = 0x4b;
      response = await teacher.upload('/admin/student-imports', huge, '名单.xlsx');
      assert.equal(response.status, 422);
      assert.equal(response.code, 'validation_error');

      response = await teacher.write('POST', '/admin/student-imports', undefined);
      assert.equal(response.status, 422);

      const blank = await uploadImport(teacher, template, '学生建档导入模板_v1.5.xlsx');
      assert.equal(blank.status, 'invalid');
      assert.match(blank.error_message, /未找到可导入的数据行/);

      const wrongSheet = await uploadImport(
        teacher,
        buildWorkbook({
          sheets: [rosterSheet([{ number: 2, values: ['0000000901', '测试', '', '', ''] }], { name: '填写说明' })],
        }),
      );
      assert.equal(wrongSheet.status, 'invalid');
      assert.match(wrongSheet.error_message, /学生建档/);

      const wrongHeader = await uploadImport(
        teacher,
        buildWorkbook({
          sheets: [
            {
              name: '学生建档',
              rows: [
                {
                  number: 1,
                  cells: Object.fromEntries(
                    ['学号', '姓名', '级部', '年级', '编号'].map((value, index) => [
                      String.fromCharCode(65 + index),
                      value,
                    ]),
                  ),
                },
                { number: 2, cells: { A: '0000000902', B: '测试' } },
              ],
            },
          ],
        }),
      );
      assert.equal(wrongHeader.status, 'invalid');
      assert.match(wrongHeader.error_message, /表头/);

      const tooMany = await uploadImport(
        teacher,
        workbook(
          Array.from({ length: 5_001 }, (_, index) => ({
            number: index + 2,
            values: [String(8100000000 + index), '超限学生' + index, '', '', ''],
          })),
        ),
      );
      assert.equal(tooMany.status, 'invalid');
      assert.match(tooMany.error_message, /5,000/);
    });

    await t.test('上传幂等键只受理一次，内容变化时冲突', async () => {
      const bytes = workbook([{ number: 2, values: ['0000000903', '幂等甲', '', '', ''] }]);
      const key = randomUUID();
      const first = await teacher.upload('/admin/student-imports', bytes, '幂等.xlsx', key);
      assert.equal(first.status, 202);
      const repeated = await teacher.upload('/admin/student-imports', bytes, '幂等.xlsx', key);
      assert.deepEqual(repeated, first);
      assert.equal((await waitImport(teacher, first.data.id)).status, 'ready');
      const changed = await teacher.upload(
        '/admin/student-imports',
        workbook([{ number: 2, values: ['0000000904', '幂等乙', '', '', ''] }]),
        '幂等.xlsx',
        key,
      );
      assert.equal(changed.status, 409);
      assert.equal(changed.code, 'conflict');
    });

    await t.test('预览按原表行号定位格式、公式、数值、未知列与资料冲突', async () => {
      const rows = [
        { number: 2, values: ['0000000101', '张三', '本科生', '2026', '0000000201'] },
        { number: 3, values: ['0000000001', '体验学生', '', '', ''] },
        { number: 4, values: ['0000000002', '甲负责人改名', '', '', ''] },
        { number: 5, values: ['0000000101', '张三', '本科生', '2026', '0000000201'] },
        { number: 6, values: ['0000000102', '李四', '', '', '123'] },
        { number: 7, values: [num(1234567890), '数值学号', '', '', ''] },
        { number: 8, values: [formula('A2', '0000000101'), '公式学号', '', '', ''] },
        {
          number: 9,
          values: [],
          extra: { A: { blank: true }, B: { blank: true }, C: { blank: true }, D: { blank: true }, E: { blank: true } },
        },
        { number: 10, values: ['0000000103', { inline: '王五' }, '', '', ''] },
        { number: 11, values: ['0000000104', '未知列', '', '', ''], extra: { G: '多余' } },
        { number: 250, values: ['0000000105', '赵六', '', '', ''] },
      ];
      const sheet = rosterSheet(rows, { dimension: 'A1:E201', tableRef: 'A1:E201' });
      const batch = await uploadImport(
        teacher,
        buildWorkbook({ sheets: [sheet], prefix: true, sharedStrings: true }),
      );
      assert.equal(batch.status, 'invalid');
      assert.equal(batch.row_count, 10);
      assert.equal(batch.created_count, 3);
      assert.equal(batch.skipped_count, 2);
      assert.equal(batch.error_count, 5);
      assert.equal(batch.source_hash.length, 64);

      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows?page_size=100'))
        .data;
      assert.equal(preview.total, 10);
      assert.deepEqual(
        preview.items.map((row) => row.row_number),
        [2, 3, 4, 5, 6, 7, 8, 10, 11, 250],
      );
      const byNumber = new Map(preview.items.map((row) => [row.row_number, row]));
      assert.equal(byNumber.get(2).action, 'create');
      assert.equal(byNumber.get(2).student_no, '0000000101');
      assert.equal(byNumber.get(2).class_name, '0000000201');
      assert.equal(byNumber.get(3).action, 'skip_identical');
      assert.equal(byNumber.get(3).student_no, '0000000001');
      assert.equal(byNumber.get(4).action, 'error');
      assert(byNumber.get(4).errors.some((error) => error.code === 'profile_conflict'));
      assert.equal(byNumber.get(5).action, 'skip_identical');
      assert(byNumber.get(6).errors.some((error) => error.field === 'class_name'));
      assert.equal(byNumber.get(7).raw_values.student_no, '1234567890');
      assert(!Object.hasOwn(byNumber.get(7), 'student_no'));
      assert(byNumber.get(7).errors.some((error) => error.code === 'not_text'));
      assert.equal(byNumber.get(8).raw_values.student_no, '=A2');
      assert(byNumber.get(8).errors.some((error) => error.code === 'formula_not_allowed'));
      assert(byNumber.get(10).action, 'create');
      assert(byNumber.get(11).errors.some((error) => error.code === 'unknown_column' && error.field === 'G'));
      assert.equal(byNumber.get(250).action, 'create');
      assert(!byNumber.has(9));

      const paged = (await teacher.request('/admin/student-imports/' + batch.id + '/rows?page_size=4&page=2'))
        .data;
      assert.equal(paged.total, 10);
      assert.deepEqual(
        paged.items.map((row) => row.row_number),
        [6, 7, 8, 10],
      );
      assert.equal((await teacher.request('/admin/student-imports/' + batch.id + '/rows?page=0')).status, 422);

      const denied = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(denied.status, 409);
      assert.equal(denied.code, 'invalid_state');
      assert.equal((await student.request('/admin/student-imports/' + batch.id)).status, 403);
      assert.equal((await student.request('/admin/student-imports/' + batch.id + '/rows')).status, 403);
      assert.equal((await student.upload('/admin/student-imports', template)).status, 403);
      assert.equal(
        (await student.write('POST', '/admin/student-imports/' + batch.id + '/commit', commitBody(batch)))
          .status,
        403,
      );
    });

    await t.test('相同资料的第二行有行级错误时不被去重掩盖', async () => {
      const profile = ['0000000801', '重复行学生', '本科生', '2026', '0000000901'];
      const batch = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: profile },
          { number: 3, values: profile, extra: { G: '多余列' } },
        ]),
      );
      assert.equal(batch.status, 'invalid');
      assert.equal(batch.row_count, 2);
      assert.equal(batch.created_count, 1);
      assert.equal(batch.skipped_count, 0);
      assert.equal(batch.error_count, 1);
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      const byNumber = new Map(preview.items.map((row) => [row.row_number, row]));
      assert.equal(byNumber.get(2).action, 'create');
      assert.equal(byNumber.get(3).action, 'error');
      assert(
        byNumber.get(3).errors.some((error) => error.code === 'unknown_column' && error.field === 'G'),
      );
      assert.equal(byNumber.get(3).raw_values.G, '多余列');
      const blocked = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(blocked.status, 409);
      assert.equal(blocked.code, 'invalid_state');
    });

    await t.test('确认后新账号启用、以学号后六位首次登录并强制改密', async () => {
      const batch = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: ['0000000201', '陈一', '本科生', '2026', '0000000301'] },
          { number: 3, values: ['0000000202', '陈二', '', '', ''] },
        ]),
      );
      assert.equal(batch.status, 'ready');
      assert.equal(batch.error_count, 0);
      assert.equal(batch.created_count, 2);
      const key = randomUUID();
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
        key,
      );
      assert.equal(committed.status, 200);
      assert.equal(committed.data.status, 'committed');
      assert.equal(committed.data.created_count, 2);
      assert.equal(committed.data.skipped_count, 0);
      assert.equal(committed.data.version, batch.version + 1);

      const stored = await db.account.findUniqueOrThrow({
        where: { username: '0000000201' },
        include: { roles: true, student: true },
      });
      assert.equal(stored.active, true);
      assert.equal(stored.must_change_password, true);
      assert.deepEqual(stored.roles.map((role) => role.role), ['student']);
      assert.equal(stored.student.student_no, '0000000201');
      assert.equal(stored.student.cohort, '本科生');
      assert.equal(stored.student.grade, '2026');
      assert.equal(stored.student.class_name, '0000000301');

      const newcomer = browser(base);
      const login = await newcomer.signIn('0000000201', '000201', 'fresh-password9');
      assert.equal(login.data.auth_state, 'password_change_required');
      assert.deepEqual(login.data.roles, ['student']);
      const me = await newcomer.request('/me');
      assert.equal(me.status, 200);
      assert.equal(me.data.student.student_no, '0000000201');
      assert.equal(me.data.display_name, '陈一');
      assert.equal((await newcomer.request('/admin/students')).status, 403);
      assert.equal((await newcomer.request('/admin/student-imports/' + batch.id)).status, 403);

      assert.deepEqual(
        await teacher.write('POST', '/admin/student-imports/' + batch.id + '/commit', commitBody(batch), key),
        committed,
      );
      const again = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(again.status, 409);
      assert.equal(again.code, 'invalid_state');
    });

    await t.test('确认事务复核版本与源摘要，冲突整批回滚', async () => {
      const batch = await uploadImport(
        teacher,
        workbook([{ number: 2, values: ['0000000203', '顾三', '', '', ''] }]),
      );
      assert.equal(batch.status, 'ready');
      const stale = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        { expected_version: batch.version + 1, source_hash: batch.source_hash },
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.code, 'version_conflict');
      const tampered = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        { expected_version: batch.version, source_hash: '0'.repeat(64) },
      );
      assert.equal(tampered.status, 409);
      assert.equal(tampered.code, 'conflict');
      assert.equal(await db.student.count({ where: { student_no: '0000000203' } }), 0);
      const ok = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.data.status, 'committed');
    });

    await t.test('重复导入不重置密码、不恢复停用账号、不新增角色', async () => {
      const before = await db.account.findUniqueOrThrow({
        where: { username: '0000000201' },
        include: { roles: true },
      });
      await db.account.update({ where: { id: before.id }, data: { active: false } });
      const batch = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: ['0000000201', '陈一', '本科生', '2026', '0000000301'] },
          { number: 3, values: ['0000000202', '陈二', '', '', ''] },
        ]),
      );
      assert.equal(batch.status, 'ready');
      assert.equal(batch.created_count, 0);
      assert.equal(batch.skipped_count, 2);
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      assert.equal(preview.items[0].action, 'skip_identical');
      assert.equal(preview.items[0].resulting_account_status, 'inactive');
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(committed.status, 200);
      assert.equal(committed.data.created_count, 0);
      assert.equal(committed.data.skipped_count, 2);
      const after = await db.account.findUniqueOrThrow({
        where: { id: before.id },
        include: { roles: true },
      });
      assert.equal(after.password_hash, before.password_hash);
      assert.equal(after.active, false);
      assert.equal(after.must_change_password, false);
      assert.deepEqual(after.roles.map((role) => role.role), ['student']);
      const other = await db.account.findUniqueOrThrow({ where: { username: '0000000202' } });
      assert.equal(other.must_change_password, true);
      assert.equal(other.active, true);
    });

    await t.test('另一批先写入相同资料则跳过，资料冲突整批回滚', async () => {
      const firstBytes = workbook([
        { number: 2, values: ['0000000301', '甲同学', '本科生', '2026', ''] },
        { number: 3, values: ['0000000302', '乙同学', '', '', ''] },
      ]);
      const first = await uploadImport(teacher, firstBytes);
      const duplicate = await uploadImport(teacher, firstBytes);
      const conflict = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: ['0000000301', '甲同学改名', '本科生', '2026', ''] },
          { number: 3, values: ['0000000303', '丙同学', '', '', ''] },
        ]),
      );
      assert.equal(first.status, 'ready');
      assert.equal(duplicate.status, 'ready');
      assert.equal(conflict.status, 'ready');

      assert.equal(
        (await teacher.write('POST', '/admin/student-imports/' + first.id + '/commit', commitBody(first)))
          .data.created_count,
        2,
      );
      const replay = await teacher.write(
        'POST',
        '/admin/student-imports/' + duplicate.id + '/commit',
        commitBody(duplicate),
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.data.created_count, 0);
      assert.equal(replay.data.skipped_count, 2);
      assert.equal(await db.student.count({ where: { student_no: '0000000301' } }), 1);

      const rejected = await teacher.write(
        'POST',
        '/admin/student-imports/' + conflict.id + '/commit',
        commitBody(conflict),
      );
      assert.equal(rejected.status, 409);
      assert.equal(rejected.code, 'conflict');
      assert(rejected.details.some((detail) => detail.row === 2));
      assert.equal(await db.student.count({ where: { student_no: '0000000303' } }), 0);
      assert.equal(await db.account.count({ where: { username: '0000000303' } }), 0);
    });

    await t.test('系统失败可按契约重试，invalid 与 committed 不允许重试', async () => {
      const batch = await uploadImport(
        teacher,
        workbook([{ number: 2, values: ['0000000401', '丁同学', '', '', ''] }]),
      );
      assert.equal(batch.status, 'ready');
      await db.studentImportBatch.update({
        where: { id: batch.id },
        data: { status: 'failed', error_message: '系统处理失败', version: { increment: 1 } },
      });
      const failed = (await teacher.request('/admin/student-imports/' + batch.id)).data;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error_message, '系统处理失败');
      const key = randomUUID();
      const retried = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/retry',
        { expected_version: failed.version },
        key,
      );
      assert.equal(retried.status, 202);
      assert.equal(retried.data.status, 'validating');
      const replay = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/retry',
        { expected_version: failed.version },
        key,
      );
      assert.deepEqual(replay, retried);
      const ready = await waitImport(teacher, batch.id);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.error_count, 0);

      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(ready),
      );
      assert.equal(committed.status, 200);
      const invalidRetry = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/retry',
        { expected_version: committed.data.version },
      );
      assert.equal(invalidRetry.status, 409);
      assert.equal(invalidRetry.code, 'invalid_state');

      const invalidBatch = await uploadImport(
        teacher,
        workbook([{ number: 2, values: [num(1234567890), '错误学号', '', '', ''] }]),
      );
      assert.equal(invalidBatch.status, 'invalid');
      const invalidState = await teacher.write(
        'POST',
        '/admin/student-imports/' + invalidBatch.id + '/retry',
        { expected_version: invalidBatch.version },
      );
      assert.equal(invalidState.status, 409);
      assert.equal(invalidState.code, 'invalid_state');

      await db.studentImportBatch.update({
        where: { id: batch.id },
        data: { status: 'failed', version: { increment: 1 } },
      });
      const current = (await teacher.request('/admin/student-imports/' + batch.id)).data;
      const stale = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/retry',
        { expected_version: current.version + 1 },
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.code, 'version_conflict');
      assert.equal(
        (await teacher.write('POST', '/admin/student-imports/' + batch.id + '/retry', {
          expected_version: current.version,
        })).status,
        202,
      );
      assert.equal((await waitImport(teacher, batch.id)).status, 'ready');
    });

    await t.test('学生档案列表支持筛选、分页且仅老师可读', async () => {
      const all = (await teacher.request('/admin/students')).data;
      assert(all.total >= 5);
      assert.equal(all.page, 1);
      assert.equal(all.page_size, 20);
      const byNo = (await teacher.request('/admin/students?q=0000000201')).data;
      assert.equal(byNo.total, 1);
      assert.equal(byNo.items[0].name, '陈一');
      assert.equal(byNo.items[0].status, 'inactive');
      const byName = (await teacher.request('/admin/students?q=' + encodeURIComponent('陈二'))).data;
      assert.equal(byName.total, 1);
      assert.equal(byName.items[0].student_no, '0000000202');
      const cohort = (await teacher.request('/admin/students?cohort=' + encodeURIComponent('本科生'))).data;
      assert(cohort.items.some((item) => item.student_no === '0000000201'));
      assert(cohort.items.every((item) => item.cohort === '本科生'));
      assert(cohort.cohort_options.includes('本科生'));
      assert(cohort.cohort_options.every((value) => value.length > 0));
      const grade = (await teacher.request('/admin/students?grade=2026&page_size=100')).data;
      assert(grade.grade_options.every((value) => /^[0-9]{4}$/.test(value)));
      assert(grade.cohort_options.includes('本科生'));
      const active = (await teacher.request('/admin/students?status=active&page_size=100')).data;
      assert(active.items.every((item) => item.status === 'active'));
      const inactive = (await teacher.request('/admin/students?status=inactive')).data;
      assert(inactive.items.some((item) => item.student_no === '0000000201'));
      const paged = (await teacher.request('/admin/students?page_size=2&page=2')).data;
      assert.equal(paged.items.length, 2);
      const ordered = all.items.map((item) => item.student_no);
      assert.deepEqual([...ordered].sort(), ordered);
      for (const query of ['?page=0', '?page_size=101', '?status=unknown', '?q=' + 'x'.repeat(101)])
        assert.equal((await teacher.request('/admin/students' + query)).status, 422);
      assert.equal((await student.request('/admin/students')).status, 403);
    });

    await t.test('SQL 注入文本按名单内容处理，不改变查询结构', async () => {
      const students = await db.student.count();
      const accounts = await db.account.count();
      const injected = workbook([
        {
          number: 2,
          values: ["0000000001' OR '1'='1", "注入姓名'); DROP TABLE student;--", '', '', ''],
        },
        {
          number: 3,
          values: ['0000000003', "x' OR 1=1 --", '', '', "0000000001' OR '1'='1"],
        },
      ]);
      const batch = await uploadImport(teacher, injected, '注入.xlsx');
      assert.equal(batch.status, 'invalid');
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      assert.equal(preview.items.length, 2);
      assert.equal(
        preview.items[0].raw_values.student_no,
        "0000000001' OR '1'='1",
      );
      assert(
        preview.items[0].errors.some((error) => error.field === 'student_no' && error.code === 'format'),
      );
      assert(preview.items[1].errors.some((error) => error.field === 'class_name'));
      // 表仍存在、数据量未变，说明注入文本没有进入 SQL 结构
      assert.equal(await db.student.count(), students);
      assert.equal(await db.account.count(), accounts);
      const byQuery = await teacher.request(
        '/admin/students?q=' + encodeURIComponent("' OR 1=1 --"),
      );
      assert.equal(byQuery.status, 200);
      assert.equal(byQuery.data.total, 0);
      const byCohort = await teacher.request(
        '/admin/students?cohort=' + encodeURIComponent("' OR 1=1 --"),
      );
      assert.equal(byCohort.status, 200);
      assert.equal(byCohort.data.total, 0);
      for (const bad of ["1' OR '1'='1", '1;DROP TABLE student']) {
        const response = await teacher.request(
          '/admin/student-imports/' + encodeURIComponent(bad),
        );
        assert.equal(response.status, 400);
      }
      assert.equal((await teacher.request('/admin/students')).status, 200);
    });

    await t.test('畸形或压缩炸弹式工作簿按结构错误快速拒绝，不退化为二次复杂度', async () => {
      const namespace =
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
      const unclosedRows = buildWorkbook({
        sheets: [
          {
            name: '学生建档',
            xml:
              '<?xml version="1.0" encoding="utf-8"?><x:worksheet ' +
              namespace +
              '><x:sheetData>' +
              '<x:row>'.repeat(200_000) +
              '</x:sheetData></x:worksheet>',
          },
        ],
        prefix: true,
      });
      const started = Date.now();
      const rowsBatch = await uploadImport(teacher, unclosedRows, '畸形行.xlsx');
      const elapsed = Date.now() - started;
      assert.equal(rowsBatch.status, 'invalid');
      assert.match(rowsBatch.error_message, /XML 结构不完整|工作簿/);
      assert.ok(elapsed < 5_000, '畸形行工作簿处理耗时 ' + elapsed + 'ms');

      const unclosedCells = buildWorkbook({
        sheets: [
          {
            name: '学生建档',
            xml:
              '<?xml version="1.0" encoding="utf-8"?><x:worksheet ' +
              namespace +
              '><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>学号</x:v></x:c>' +
              '<x:c r="A2"><x:c r="A3">'.repeat(200_000) +
              '</x:row></x:sheetData></x:worksheet>',
          },
        ],
        prefix: true,
      });
      const startedCells = Date.now();
      const cellsBatch = await uploadImport(teacher, unclosedCells, '畸形单元格.xlsx');
      const elapsedCells = Date.now() - startedCells;
      assert.equal(cellsBatch.status, 'invalid');
      assert.ok(elapsedCells < 5_000, '畸形单元格工作簿处理耗时 ' + elapsedCells + 'ms');

      // 服务在畸形输入后仍正常响应
      assert.equal((await teacher.request('/admin/students')).status, 200);
      assert.equal((await teacher.request('/admin/student-imports/' + rowsBatch.id)).status, 200);
    });

    await t.test('学院随名单导入、在档案中返回，并参与去重与冲突判定', async () => {
      const batch = await uploadImport(
        teacher,
        workbook([
          {
            number: 2,
            values: ['0000001101', '学院甲', '本科生', '2026', '0000001201', '信息与通信工程学院'],
          },
          { number: 3, values: ['0000001102', '学院乙', '', '', '', '计算机学院'] },
        ]),
      );
      assert.equal(batch.status, 'ready');
      assert.equal(batch.created_count, 2);
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      const rows = new Map(preview.items.map((row) => [row.row_number, row]));
      assert.equal(rows.get(2).college, '信息与通信工程学院');
      assert.equal(rows.get(3).college, '计算机学院');
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(committed.status, 200);
      const stored = await db.student.findUniqueOrThrow({ where: { student_no: '0000001101' } });
      assert.equal(stored.college, '信息与通信工程学院');
      const listed = (await teacher.request('/admin/students?q=0000001101')).data;
      assert.equal(listed.items[0].college, '信息与通信工程学院');

      const conflict = await uploadImport(
        teacher,
        workbook([
          {
            number: 2,
            values: ['0000001103', '学院冲突', '本科生', '2026', '0000001202', '信息与通信工程学院'],
          },
          {
            number: 3,
            values: ['0000001103', '学院冲突', '本科生', '2026', '0000001202', '计算机学院'],
          },
        ]),
      );
      assert.equal(conflict.status, 'invalid');
      assert.equal(conflict.error_count, 2);
      const conflictRows = (await teacher.request('/admin/student-imports/' + conflict.id + '/rows'))
        .data;
      assert(
        conflictRows.items.every((row) =>
          row.errors.some((error) => error.code === 'duplicate_conflict'),
        ),
      );
    });

    await t.test('v1.5 五列名单不含级部列也可导入，非法年级按原表行报错', async () => {
      const fiveColumns = buildWorkbook({
        sheets: [
          rosterSheet(
            [
              {
                number: 2,
                values: ['2026123456', '五列学生', '', '2026', '0000001901'],
              },
            ],
            { includeCohort: false },
          ),
        ],
        prefix: true,
        sharedStrings: true,
      });
      const batch = await uploadImport(teacher, fiveColumns);
      assert.equal(batch.status, 'ready');
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      assert.equal(preview.items[0].cohort, undefined);
      assert.equal(preview.items[0].grade, '2026');
      assert.equal(
        (
          await teacher.write(
            'POST',
            '/admin/student-imports/' + batch.id + '/commit',
            commitBody(batch),
          )
        ).status,
        200,
      );
      const stored = await db.student.findUniqueOrThrow({ where: { student_no: '2026123456' } });
      assert.equal(stored.cohort, null);
      assert.equal(stored.grade, '2026');

      const badGrade = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: ['2026001902', '非法年级', '', '大一', ''] },
        ]),
      );
      assert.equal(badGrade.status, 'invalid');
      const badRows = (await teacher.request('/admin/student-imports/' + badGrade.id + '/rows')).data;
      assert.equal(badRows.items[0].grade, undefined);
      assert.equal(badRows.items[0].raw_values.grade, '大一');
      assert(
        badRows.items[0].errors.some(
          (error) => error.field === 'grade' && error.code === 'format',
        ),
      );
      assert.equal(
        (
          await teacher.write(
            'POST',
            '/admin/student-imports/' + badGrade.id + '/commit',
            commitBody(badGrade),
          )
        ).status,
        409,
      );
    });

    await t.test('只按随名单提供的列比较，预览和确认均保留旧档案的级部', async () => {
      const values = ['2026999101', '跨模板学生', '本科生', '2026', '2026000101', '示例学院'];
      const roster = (fields, options) => workbook([{ number: 2, values: fields }], options);
      const confirm = batch => teacher.write('POST', '/admin/student-imports/' + batch.id + '/commit', commitBody(batch));
      const newFile = roster(values, { includeCohort: false });
      const pending = await uploadImport(teacher, newFile);
      assert.equal(pending.status, 'ready');
      const old = await uploadImport(teacher, roster(values));
      assert.equal((await confirm(old)).data.created_count, 1);
      assert.equal((await confirm(pending)).data.skipped_count, 1);
      const replay = await uploadImport(teacher, newFile);
      assert.equal(replay.skipped_count, 1);
      assert.equal((await confirm(replay)).data.skipped_count, 1);
      const student = await db.student.findUniqueOrThrow({ where: { student_no: values[0] } });
      assert.equal(student.cohort, '本科生');
      // An explicitly present, empty cohort must still conflict with an existing value.
      assert.equal((await uploadImport(teacher, roster(values.with(2, '')))).status, 'invalid');
    });

    await t.test('年级缺省取学号前四位，统一保存为 YYYY 并支持年级筛选', async () => {
      const batch = await uploadImport(
        teacher,
        workbook([
          {
            number: 2,
            values: ['2026123401', '年级缺省甲', '本科生', '', '0000001801', '信息与通信工程学院'],
          },
          {
            number: 3,
            values: ['2025123402', '年级显式乙', '本科生', '2025级', '', ''],
          },
        ]),
      );
      assert.equal(batch.status, 'ready');
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      const rows = new Map(preview.items.map((row) => [row.row_number, row]));
      assert.equal(rows.get(2).grade, '2026');
      assert.equal(rows.get(3).grade, '2025');
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(committed.status, 200);
      const derived = await db.student.findUniqueOrThrow({ where: { student_no: '2026123401' } });
      assert.equal(derived.grade, '2026');
      const explicit = await db.student.findUniqueOrThrow({ where: { student_no: '2025123402' } });
      assert.equal(explicit.grade, '2025');

      const listed = (await teacher.request('/admin/students?grade=2026&page_size=100')).data;
      assert(listed.grade_options.includes('2026'));
      assert(listed.grade_options.includes('2025'));
      assert(listed.items.every((item) => item.grade === '2026'));
      assert(listed.items.some((item) => item.student_no === '2026123401'));
      const none = (await teacher.request('/admin/students?grade=2001')).data;
      assert.equal(none.total, 0);
      assert.deepEqual(none.grade_options, listed.grade_options);
      assert.deepEqual(none.grade_options, [...new Set(none.grade_options)].sort().reverse());
      assert.deepEqual(none.cohort_options, listed.cohort_options);
      assert.equal(new Set(none.cohort_options).size, none.cohort_options.length);
      assert.equal((await teacher.request('/admin/students?grade=26')).status, 422);
    });

    await t.test('表头按名称识别，列顺序不影响导入', async () => {
      const reordered = buildWorkbook({
        sheets: [
          rosterSheet(
            [
              {
                number: 2,
                values: ['0000001601', '乱序学生', '本科生', '2026', '0000001701', '信息与通信工程学院'],
              },
            ],
            { columnOrder: ['学院', '班级', '年级', '姓名', '学号', '级部'] },
          ),
        ],
        prefix: true,
        sharedStrings: true,
      });
      const batch = await uploadImport(teacher, reordered);
      assert.equal(batch.status, 'ready');
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      const row = preview.items[0];
      assert.equal(row.student_no, '0000001601');
      assert.equal(row.name, '乱序学生');
      assert.equal(row.cohort, '本科生');
      assert.equal(row.grade, '2026');
      assert.equal(row.class_name, '0000001701');
      assert.equal(row.college, '信息与通信工程学院');
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(committed.status, 200);
      const stored = await db.student.findUniqueOrThrow({ where: { student_no: '0000001601' } });
      assert.equal(stored.college, '信息与通信工程学院');
    });

    await t.test('学院列缺省的五列名单仍可导入', async () => {
      const legacy = buildWorkbook({
        sheets: [
          rosterSheet(
            [
              {
                number: 2,
                values: ['0000001401', '缺省学院学生', '本科生', '2026', '0000001501'],
              },
            ],
            { includeCollege: false },
          ),
        ],
        prefix: true,
        sharedStrings: true,
      });
      const batch = await uploadImport(teacher, legacy);
      assert.equal(batch.status, 'ready');
      assert.equal(batch.created_count, 1);
      const preview = (await teacher.request('/admin/student-imports/' + batch.id + '/rows')).data;
      assert.equal(preview.items[0].college, undefined);
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + batch.id + '/commit',
        commitBody(batch),
      );
      assert.equal(committed.status, 200);
      const stored = await db.student.findUniqueOrThrow({ where: { student_no: '0000001401' } });
      assert.equal(stored.college, null);
    });

    await t.test('5,000 条非空数据行可校验，表格范围外与空行按规则处理', async () => {
      const rows = Array.from({ length: 5_000 }, (_, index) => ({
        number: index + 2,
        values: [String(8200000000 + index), '批量学生' + index, '', '', ''],
      }));
      const batch = await uploadImport(
        teacher,
        workbook(rows, { dimension: 'A1:E201', tableRef: 'A1:E201' }),
      );
      assert.equal(batch.status, 'ready');
      assert.equal(batch.row_count, 5_000);
      assert.equal(batch.created_count, 5_000);
      assert.equal(batch.error_count, 0);
    });
    await t.test('鉴权与角色边界：仅有效教职工可读写，缓存回执也重新授权', async () => {
      const multipart = (bytes) => {
        const form = new FormData();
        form.append(
          'file',
          new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
          '名单.xlsx',
        );
        return form;
      };
      const batch = await uploadImport(
        teacher,
        workbook([{ number: 2, values: ['0000000701', '鉴权批次学生', '', '', ''] }]),
      );

      // 匿名访问
      const anonymous = browser(base);
      for (const [url, init] of [
        ['/admin/students'],
        ['/admin/student-imports/' + batch.id],
        ['/admin/student-imports/' + batch.id + '/rows'],
      ])
        assert.equal((await anonymous.request(url, init)).status, 401);
      assert.equal((await anonymous.upload('/admin/student-imports', template)).status, 401);
      assert.equal(
        (
          await anonymous.write('POST', '/admin/student-imports/' + batch.id + '/commit', {
            expected_version: 1,
            source_hash: batch.source_hash,
          })
        ).status,
        401,
      );

      // 首次改密未完成：会话守卫在文件解析前拦截
      const pendingNo = '0000000702';
      const pending = await uploadImport(
        teacher,
        workbook([{ number: 2, values: [pendingNo, '待改密学生', '', '', ''] }]),
      );
      assert.equal(
        (
          await teacher.write(
            'POST',
            '/admin/student-imports/' + pending.id + '/commit',
            commitBody(pending),
          )
        ).status,
        200,
      );
      const pendingStudent = browser(base);
      const pendingInitial = pendingNo.slice(-6);
      await pendingStudent.signIn(pendingNo, pendingInitial);
      const gated = await pendingStudent.request('/admin/students');
      assert.equal(gated.status, 403);
      assert.equal(gated.code, 'password_change_required');
      const gatedUpload = await pendingStudent.upload('/admin/student-imports', template);
      assert.equal(gatedUpload.status, 403);
      assert.equal(gatedUpload.code, 'password_change_required');
      await pendingStudent.request('/auth/change-password', {
        method: 'POST',
        body: { current_password: pendingInitial, new_password: 'PendingPass123' },
      });
      await pendingStudent.request('/auth/csrf');
      const studentDenied = await pendingStudent.request('/admin/students');
      assert.equal(studentDenied.status, 403);
      assert.equal(studentDenied.code, 'forbidden');

      // 普通负责人不是教职工
      const organizer = browser(base);
      await organizer.signIn('0000000002', '000002', 'OrganizerPass123');
      assert.equal((await organizer.request('/admin/students')).status, 403);
      assert.equal((await organizer.upload('/admin/student-imports', template)).status, 403);

      // CSRF：缺令牌或伪造令牌均拒绝；GET 不要求 CSRF
      const body = { expected_version: batch.version, source_hash: batch.source_hash };
      const missing = await teacher.request('/admin/student-imports/' + batch.id + '/commit', {
        method: 'POST',
        body,
        key: randomUUID(),
        omitCsrf: true,
      });
      assert.equal(missing.status, 403);
      assert.equal(missing.code, 'forbidden');
      const forged = await teacher.request('/admin/student-imports/' + batch.id + '/commit', {
        method: 'POST',
        body,
        key: randomUUID(),
        csrfToken: 'forged-token',
      });
      assert.equal(forged.status, 403);
      assert.equal(
        (
          await teacher.request('/admin/student-imports', {
            method: 'POST',
            form: multipart(template),
            key: randomUUID(),
            omitCsrf: true,
          })
        ).status,
        403,
      );
      assert.equal((await teacher.request('/admin/students')).status, 200);

      // 角色过期：读接口拒绝；同一幂等键的已成功回执也必须重新授权
      const replayBatch = await uploadImport(
        teacher,
        workbook([
          { number: 2, values: ['0000000703', '回放学生甲', '', '', ''] },
          { number: 3, values: ['0000000704', '回放学生乙', '', '', ''] },
        ]),
      );
      const commitKey = randomUUID();
      const committed = await teacher.write(
        'POST',
        '/admin/student-imports/' + replayBatch.id + '/commit',
        commitBody(replayBatch),
        commitKey,
      );
      assert.equal(committed.status, 200);
      const teacherAccount = await db.account.findUniqueOrThrow({
        where: { username: 'demo.teacher' },
      });
      const grant = {
        account_id_role: { account_id: teacherAccount.id, role: 'reviewer' },
      };
      await db.roleGrant.update({
        where: grant,
        data: { expires_at: new Date(Date.now() - 1_000) },
      });
      try {
        assert.equal((await teacher.request('/admin/students')).status, 403);
        assert.equal((await teacher.upload('/admin/student-imports', template)).status, 403);
        const replay = await teacher.write(
          'POST',
          '/admin/student-imports/' + replayBatch.id + '/commit',
          commitBody(replayBatch),
          commitKey,
        );
        assert.equal(replay.status, 403);
        assert.equal(replay.code, 'forbidden');
      } finally {
        await db.roleGrant.update({ where: grant, data: { expires_at: null } });
      }
      const replay = await teacher.write(
        'POST',
        '/admin/student-imports/' + replayBatch.id + '/commit',
        commitBody(replayBatch),
        commitKey,
      );
      assert.deepEqual(replay, committed);

      // 技术管理员同样获准
      const tech = browser(base);
      await tech.signIn('demo.admin', adminPassword);
      assert.equal((await tech.request('/admin/students')).status, 200);
      assert.equal((await tech.request('/admin/student-imports/' + replayBatch.id)).status, 200);

      // 退出后会话立即失效
      const leaving = browser(base);
      await leaving.signIn('0000000001', 'student-new-pass1');
      assert.equal((await leaving.request('/auth/logout', { method: 'POST' })).status, 200);
      assert.equal((await leaving.request('/admin/students')).status, 401);
    });

    await t.test('服务启动时恢复已受理但未完成校验的批次', async () => {
      const bytes = workbook([{ number: 2, values: ['0000000901', '重启恢复学生', '', '', ''] }]);
      const teacherAccount = await db.account.findUniqueOrThrow({ where: { username: 'demo.teacher' } });
      const stuck = await db.studentImportBatch.create({
        data: {
          status: 'validating',
          version: 1,
          source_hash: createHash('sha256').update(bytes).digest('hex'),
          source_name: '重启恢复.xlsx',
          source_data: new Uint8Array(bytes),
          created_by: teacherAccount.id,
        },
      });
      const recoveryApp = await createApp();
      await recoveryApp.listen(0, '127.0.0.1');
      try {
        const result = await waitImport(teacher, stuck.id);
        assert.equal(result.status, 'ready');
        assert.equal(result.created_count, 1);
        const committed = await teacher.write(
          'POST',
          '/admin/student-imports/' + stuck.id + '/commit',
          commitBody(result),
        );
        assert.equal(committed.status, 200);
        assert.equal(committed.data.status, 'committed');
      } finally {
        await recoveryApp.close();
      }
    });

  } finally {
    await app?.close();
  }
});
