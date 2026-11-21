import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ledgerActivity, ledgerDay, ledgerWorkbook } from './hour-ledger-fixture.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const link = (page, name) => page.getByRole('link', { name, exact: typeof name === 'string' });
const shown = (element) => element.first().waitFor();
const text = (page, value) => page.getByText(value, { exact: typeof value === 'string' });

async function tab(page, name) {
  const entry = page.getByRole('navigation', { name: '活动工作区' }).getByRole('link', { name, exact: true });
  if (!await entry.isVisible()) await text(page, '更多').click();
  await entry.click();
}

async function sendWorkbook(page, name, bytes) {
  await page.getByLabel('工作簿', { exact: true }).setInputFiles({
    name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes,
  });
  await button(page, '上传并预览').click();
  await shown(text(page, '校验完成'));
  await button(page, '提交审核').click();
  await shown(text(page, '批次已提交审核。'));
}

// 以契约响应驱动现有页面，验证请求范围、状态和下载动作。
async function checkExportButton(page, expected, workbook) {
  const collection = '/api/v1/exports', id = randomUUID(), path = collection + '/' + id;
  const routeMatch = (url) => [collection, path, path + '/download'].includes(url.pathname);
  const expiry = new Date(Date.now() + 86400000).toISOString();
  let body, polls = 0, expired = false;
  const handler = async (route) => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const request_id = randomUUID();
    if (pathname === collection && request.method() === 'POST') {
      body = request.postDataJSON();
      return route.fulfill({ status: 202, json: { request_id, data: { id, version: 1, status: 'pending' } } });
    }
    if (pathname === path) {
      polls++;
      return route.fulfill({ json: { request_id,
        data: { id, version: expired ? 3 : 2, status: expired ? 'expired' : 'ready', expires_at: expiry } } });
    }
    if (workbook && !expired) return route.fulfill({
      contentType: 'application/octet-stream',
      headers: { 'Content-Disposition': 'attachment; filename="ledger-check.xlsx"' },
      body: workbook,
    });
    return route.fulfill({
      status: expired ? 409 : 403,
      json: { request_id, code: expired ? 'invalid_state' : 'forbidden',
        message: expired ? '文件已过期' : '当前身份无权领取此文件' },
    });
  };
  await page.route(routeMatch, handler);
  try {
    const create = button(page, '导出筛选结果'), download = button(page, '下载时长文件');
    await create.click();
    await shown(text(page, '正在生成文件…'));
    assert.equal(await create.isDisabled(), true);
    await shown(download);
    assert.deepEqual(body, expected);
    assert.equal(polls, 1);
    if (workbook) {
      const received = page.waitForEvent('download');
      await download.click();
      const file = await received;
      assert.equal(file.suggestedFilename(), 'ledger-check.xlsx');
      assert.deepEqual(await readFile(await file.path()), workbook);
      expired = true;
      await download.click();
      await shown(text(page, '文件已过期，请重新导出。'));
    } else {
      await download.click();
      await shown(text(page, '当前身份无权领取此文件'));
    }
    assert.equal(await download.count(), 0);
  } finally {
    await page.unroute(routeMatch, handler);
  }
}

export async function checkLedgerPages({ db, web, admin, owner, teacher, student, secondStudent, worker, fits, pickOption, capture, holdResponse, settleRender }) {
  const [a, manager, , b] = await db.student.findMany({ include: { account: true }, orderBy: { student_no: 'asc' }, take: 4 });
  const title = '时长账务验收活动', activity = await ledgerActivity(db, manager.account_id, title);
  const day = ledgerDay(3), file = '查账演示.xlsx';
  for (const page of [owner, teacher]) await page.setViewportSize({ width: 1440, height: 900 });
  for (const page of [student, secondStudent]) await page.setViewportSize({ width: 390, height: 844 });

  await owner.goto(web + '/managed');
  await link(owner, title).click();
  await tab(owner, '时长批次');
  await sendWorkbook(owner, file, ledgerWorkbook(activity, [{ student: a, day }]));
  const batchPath = new URL(owner.url()).pathname;
  for (const page of [student, secondStudent]) {
    await page.goto(web + '/mine');
    await link(page, '我的时长').click();
    await shown(text(page, '0.0 小时'));
  }

  await teacher.goto(admin);
  await link(teacher, /时长批次/).click();
  await link(teacher, /查账演示\.xlsx/).click();
  await shown(text(teacher, '全批 1 行 · 预计差额 +2.0 小时'));
  await shown(teacher.getByRole('cell', { name: new RegExp(a.account.display_name) }));
  await button(teacher, '批准整批').click();
  await shown(text(teacher, '批次已批准，正式时长已更新。'));
  await owner.reload();
  await shown(text(owner, '已批准'));
  assert.equal(new URL(owner.url()).pathname, batchPath);
  await tab(owner, '时长台账');
  await shown(text(owner, '筛选范围内累计 2.0 小时'));

  await student.reload();
  await shown(text(student, '筛选范围内累计 2.0 小时'));
  const row = student.getByRole('row').filter({ hasText: title });
  await row.getByText('获批安排 v1').click();
  await shown(row.getByText(/入账批次/));
  await fits(student);
  await capture(student, 'hour-ledger-mobile');
  await worker.drain();
  await link(student, '通知').click();
  await shown(text(student, title + '时长审核结果'));
  await secondStudent.reload();
  await shown(text(secondStudent, '0.0 小时'));

  await student.goto(web + '/mine/hours');
  await link(student, '反馈这笔时长').click();
  await student.getByLabel('情况说明').fill('这笔 2.0 小时并非本人服务，请复核。');
  const pending = await holdResponse(student, '**/api/v1/me/appeals');
  await button(student, '提交反馈').click();
  await pending.received;
  await link(student, '取消').click();
  const feedback = link(student, /错账反馈 · 时长账务验收活动/);
  await shown(feedback);
  await pending.release();
  await settleRender(student);
  assert.equal(new URL(student.url()).pathname, '/mine/feedback');
  await feedback.click();
  const wrongPath = new URL(student.url()).pathname;

  await link(secondStudent, '本人记录与反馈').click();
  await link(secondStudent, '提交漏记反馈').click();
  await secondStudent.getByLabel('搜索服务活动').fill(title);
  await button(secondStudent, '搜索服务活动').click();
  await secondStudent.getByLabel('服务活动', { exact: true }).selectOption(activity.id);
  await secondStudent.getByLabel('服务日期', { exact: true }).fill(day);
  await secondStudent.getByLabel('申报时长（小时，选填）').fill('2.0');
  await secondStudent.getByLabel('情况说明').fill('当天未报名，现场协助归档 2.0 小时。');
  await button(secondStudent, '提交反馈').click();
  await shown(text(secondStudent, '反馈已提交。'));
  const missingPath = new URL(secondStudent.url()).pathname;

  await tab(owner, '漏记反馈');
  await link(owner, /错账反馈 · 时长账务验收活动/).click();
  await link(owner, '新建关联修复组').click();
  await owner.getByLabel('源时长记录').locator('option').filter({ hasText: a.account.display_name }).waitFor({ state: 'attached' });
  await owner.getByLabel('目标学号').fill(b.student_no);
  await owner.getByLabel('目标姓名').fill(b.account.display_name);
  await owner.getByLabel('该笔修复原因').fill('报名表位置错位，归档后复核身份');
  await button(owner, '加入修复组').click();
  await shown(text(owner, '已添加 1 / 100 对'));
  await owner.getByLabel('整组修复原因').fill('按当日签到与归档登记核对');
  await button(owner, '提交修复组审核').click();
  await shown(text(owner, '修复组已提交审核。'));
  const groupId = new URL(owner.url()).pathname.split('/').at(-1);
  for (const [page, total] of [[student, '2.0'], [secondStudent, '0.0']]) {
    await page.goto(web + '/mine/hours');
    await shown(text(page, '筛选范围内累计 ' + total + ' 小时'));
  }

  await link(teacher, '错账修复组').click();
  await link(teacher, new RegExp(groupId.slice(0, 8))).click();
  await shown(text(teacher, /目标账/));
  await button(teacher, '批准整组').click();
  await shown(text(teacher, '修复组已批准，源账与目标账已同步更新。'));
  await capture(teacher, 'hour-correction-group');
  for (const [page, total] of [[student, '0.0'], [secondStudent, '2.0']]) {
    await page.reload();
    await shown(text(page, '筛选范围内累计 ' + total + ' 小时'));
  }
  await student.getByLabel('包含更正与撤销历史').check();
  await button(student, '查询时长').click();
  await shown(text(student, '已撤销'));
  assert.equal(await text(student, b.account.display_name).count(), 0);
  await link(teacher, '学生档案').click();
  const profile = teacher.getByRole('row').filter({ hasText: a.student_no });
  await link(profile, '查看时长').click();
  await shown(text(teacher, '0.0 小时'));

  await tab(owner, '时长台账');
  const filterInput = { from_date: day, to_date: day, include_history: true };
  for (const page of [owner, teacher]) {
    const url = new URL(page.url());
    url.search = new URLSearchParams(filterInput).toString();
    await page.goto(url.href);
  }
  await Promise.all([
    checkExportButton(owner, { type: 'activity_hours', activity_id: activity.id, ...filterInput },
      ledgerWorkbook(activity, [{ student: b, day }])),
    checkExportButton(secondStudent, { type: 'my_hours', include_history: false }),
    checkExportButton(teacher, { type: 'admin_student_hours', student_id: a.id, ...filterInput }),
  ]);

  async function close(path, method, missing) {
    await teacher.goto(admin + '/manage/appeals/' + path.split('/').at(-1));
    await teacher.getByLabel('处理方式').selectOption(method);
    if (missing) await teacher.getByLabel('结果来源').selectOption('group');
    await teacher.getByLabel('已批准的结果').selectOption(groupId);
    await teacher.getByLabel('处理意见').fill('后台核对后确认结案，含内部姓名 ' + b.account.display_name);
    await button(teacher, '确认结案').click();
    await shown(text(teacher, '反馈已结案，学生可查看本人的处理结果。'));
    const queue = teacher.locator('main .record-list-pane'), panel = teacher.locator('main .record-detail-pane');
    for (const width of [390, 1024, 1920, 1440]) {
      await teacher.setViewportSize({ width, height: 900 });
      assert.equal(await queue.isVisible(), width >= 1024);
      await shown(panel);
      await fits(teacher);
    }
    if (missing) await capture(teacher, 'appeal-workspace');
  }
  await close(wrongPath, 'rekey_hours', false);
  await close(missingPath, 'add_missing_hours', true);
  await student.goto(web + wrongPath);
  await shown(text(student, '本人错记时长已撤销。'));
  assert.equal(await text(student, b.account.display_name).count(), 0);
  await secondStudent.goto(web + missingPath);
  await shown(text(secondStudent, '本人 2.0 小时已补记。'));
  assert.equal(await text(secondStudent, a.account.display_name).count(), 0);

  await tab(owner, '时长批次');
  const reviewDays = [10, 11, 12, 13, 14, 15].map(ledgerDay);
  await sendWorkbook(owner, '跨页核实.xlsx', ledgerWorkbook(activity, reviewDays.map((serviceDay, i) => ({
    student: a, day: serviceDay, flag: i === 0 || i === 5 ? '有' : '无',
    note: i === 0 || i === 5 ? '现场记录需要核实' : '已核对实际服务',
  }))));
  await teacher.goto(admin + '/hours');
  await link(teacher, /跨页核实\.xlsx/).click();
  await button(teacher, '批准整批').click();
  await shown(text(teacher, '请为全部待核实行填写结论与意见。'));
  await pickOption(teacher, '每页', '5 条');
  await button(teacher, '核实原表第2行').click();
  await teacher.getByLabel('属实', { exact: true }).check();
  await teacher.getByLabel('第2行意见').fill('核实属实，相关情况已登记。');
  await button(teacher, '下一页').click();
  await button(teacher, '核实原表第7行').click();
  await teacher.getByLabel('不成立', { exact: true }).check();
  await teacher.getByLabel('第7行意见').fill('复核为误报。');
  await teacher.getByLabel('只看待核实行').check();
  await button(teacher, '核实原表第2行').click();
  assert.equal(await teacher.getByLabel('第2行意见').inputValue(), '核实属实，相关情况已登记。');
  await shown(text(teacher, '全批 6 行 · 预计差额 +12.0 小时'));
  const extra = await ledgerActivity(db, manager.account_id, '时长警告复核活动');
  await db.hourRecord.create({ data: { student_id: a.id, activity_id: extra.id, service_date: new Date(reviewDays[0]),
    hours: '23.0', version: 1, status: 'current', origin_schedule_revision: 1, misconduct_reported: 'none', misconduct_version: 0 } });
  const firstRequest = teacher.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/admin/hour-imports/'));
  await button(teacher, '批准整批').click();
  const firstKey = (await firstRequest).headers()['idempotency-key'];
  await shown(text(teacher, '警告已变化，请复核最新结果'));
  await shown(text(teacher, /当日预计 25.0 小时/));
  assert.equal(await teacher.getByLabel('第2行意见').inputValue(), '核实属实，相关情况已登记。');
  await teacher.getByLabel('警告接受依据').fill('跨活动的原始签到记录已逐一复核');
  const secondRequest = teacher.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/admin/hour-imports/'));
  await button(teacher, '批准整批').click();
  assert.notEqual((await secondRequest).headers()['idempotency-key'], firstKey);
  await shown(text(teacher, '批次已批准，正式时长已更新。'));
  await shown(text(teacher, /属实 · 核实属实/));
  await shown(text(teacher, /不成立 · 复核为误报/));
}
