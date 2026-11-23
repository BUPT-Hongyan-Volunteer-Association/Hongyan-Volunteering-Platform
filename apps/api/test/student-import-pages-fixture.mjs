import assert from 'node:assert/strict';
import { buildWorkbook, rosterSheet } from './xlsx-fixture.mjs';

const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const workbook = (rows) =>
  buildWorkbook({ sheets: [rosterSheet(rows, { includeCohort: false })], prefix: true, sharedStrings: true });

/** 老师从后台真实上传名单、按原表行定位错误、修正后确认，并在学生档案中查到新学生。 */
export async function checkStudentImportPages(page, admin, { fits, pickOption, db }) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const chip = (text) =>
    page.locator('.page-heading .state-chip').filter({ hasText: text }).first();
  const upload = async file => {
    // A committed batch can already be visible while its final reread still holds the picker busy.
    await page.getByRole('button', { name: '选择或拖入学生建档模板' }).filter({ hasText: '拖拽文件到此处' }).waitFor();
    await page.getByLabel('名单文件', { exact: true }).setInputFiles(file);
  };
  const profile = ['0000001201', '页面导入学生', '本科生', '2026', '0000001301'];
  const invalid = workbook([
    { number: 2, values: profile },
    { number: 3, values: profile, extra: { G: '多余列' } },
    ...Array.from({ length: 99 }, (_, index) => ({
      number: index + 4,
      values: [String(2026940000 + index), '分页学生' + index, '', index === 0 ? '大一' : '2026', ''],
    })),
  ]);
  const fixed = workbook([{ number: 2, values: profile }]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(admin);
  await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '建档导入', exact: true }).click();
  await page.waitForURL('**/manage/imports');
  await page.getByRole('heading', { name: '建档导入' }).waitFor();
  await page.getByRole('button', { name: '选择或拖入学生建档模板' }).waitFor();

  // 相同资料的第二行在 G 列多填一项：预览必须保留该行错误并阻止确认
  await upload({
    name: '含错误名单.xlsx',
    buffer: invalid,
    mimeType,
  });
  await chip('内容有误').waitFor();
  const errorRow = page.locator('tr[data-row="3"]');
  await errorRow.waitFor();
  assert.match(await errorRow.innerText(), /错误/);
  assert.match(await errorRow.innerText(), /G/);
  assert.match(await errorRow.innerText(), /多余列|未知列|表格之外/);
  const badGradeRow = page.locator('tr[data-row="4"]');
  assert.equal(await badGradeRow.getByRole('cell', { name: '大一', exact: true }).count(), 1);
  assert.equal(await button('确认建档').count(), 0);
  await fits(page);

  // 第二页暂不可用时保留第一页，重试时仍请求第二页。
  await page.route(
    url => url.pathname.endsWith('/rows') && url.searchParams.get('page') === '2',
    route => route.fulfill({ status: 503, json: { message: '明细服务暂不可用' } }),
    { times: 1 },
  );
  await button('下一页').click();
  const retryPage = button('重试第 2 页');
  await retryPage.waitFor();
  assert.ok(await errorRow.isVisible());
  await retryPage.click();
  await page.locator('tr[data-row="102"]').waitFor();
  assert.equal(await retryPage.count(), 0);

  // 修正文件后重新上传，待确认批次可确认
  await upload({
    name: '修正名单.xlsx',
    buffer: fixed,
    mimeType,
  });
  await chip('待确认').waitFor();
  await button('确认建档').click();
  await chip('已建档').waitFor();
  await page.getByText('已确认建档，可在学生档案中查到新学生。').waitFor();
  await fits(page);

  // 切换批次：旧批次详情响应较慢时不得覆盖新批次，确认必须作用于当前批次
  const uploadReady = async (name, studentNo) => {
    const before = new URL(page.url()).pathname;
    await upload({
      name,
      buffer: workbook([{ number: 2, values: [studentNo, '切换学生' + studentNo.slice(-2), '', '2026', ''] }]),
      mimeType,
    });
    await page.waitForURL(
      (url) => url.pathname !== before && /^\/manage\/imports\/[0-9a-f-]{36}$/.test(url.pathname),
    );
    await chip('待确认').waitFor();
    return new URL(page.url()).pathname.split('/').pop();
  };
  const firstId = await uploadReady('切换甲.xlsx', '0000001202');
  const secondId = await uploadReady('切换乙.xlsx', '0000001203');
  let delayedDetail = false;
  await page.route('**/admin/student-imports/' + firstId, async (route) => {
    delayedDetail = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  }, { times: 1 });
  const navigateInApp = async (path) => {
    await page.evaluate((target) => {
      window.history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
  };
  await navigateInApp('/manage/imports/' + firstId);
  await page.waitForTimeout(120);
  await navigateInApp('/manage/imports/' + secondId);
  await page.waitForURL('**/manage/imports/' + secondId);
  await chip('待确认').waitFor();
  await page.waitForTimeout(1600);
  assert.ok(delayedDetail);
  const batchHeading = page.locator('.batch-summary h2');
  await batchHeading.waitFor();
  assert.match(await batchHeading.innerText(), new RegExp(secondId.slice(0, 8)));
  await button('确认建档').click();
  await chip('已建档').waitFor();
  assert.equal(await db.account.count({ where: { username: '0000001202' } }), 0);
  assert.equal(await db.account.count({ where: { username: '0000001203' } }), 1);

  // 确认冲突：校验后另一老师先建档，当前批次确认返回 409 并保留原表行号
  const conflictNo = '0000001204';
  const beforeConflict = new URL(page.url()).pathname;
  await upload({
    name: '资料冲突.xlsx',
    buffer: workbook([{ number: 2, values: [conflictNo, '页面冲突甲', '', '2026', ''] }]),
    mimeType,
  });
  await page.waitForURL((url) => url.pathname !== beforeConflict);
  await chip('待确认').waitFor();
  await db.account.create({
    data: {
      username: conflictNo,
      display_name: '另一老师版本',
      password_hash: 'fixture',
      student: { create: { student_no: conflictNo } },
    },
  });
  await button('确认建档').click();
  const conflict = page.locator('.conflict-panel');
  await conflict.waitFor();
  assert.match(await conflict.innerText(), /原表第 2 行/);
  assert.match(await conflict.innerText(), /不一致/);
  await page.waitForTimeout(600);
  assert.ok(await conflict.isVisible());
  assert.equal(await chip('待确认').count(), 1);

  // A failed confirmation arriving after navigation belongs only to its original batch.
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route('**/admin/student-imports/*/commit', async route => {
    const response = await route.fetch();
    held.resolve(response.status());
    await release.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  await button('确认建档').click();
  try {
    assert.equal(await held.promise, 409);
    await navigateInApp('/manage/imports/' + firstId);
    await chip('待确认').waitFor();
  } finally {
    release.resolve();
  }
  await page.waitForFunction(() => document.querySelector('.page-actions button')?.disabled === false);
  assert.equal(await conflict.count(), 0);
  assert.match(await batchHeading.innerText(), new RegExp(firstId.slice(0, 8)));

  // A version conflict has no row details and must remain visible after the reread.
  await db.studentImportBatch.update({ where: { id: firstId }, data: { version: { increment: 1 } } });
  const reread = page.waitForResponse(response =>
    response.url().endsWith('/admin/student-imports/' + firstId) && response.request().method() === 'GET');
  await button('确认建档').click();
  await reread;
  await page.waitForFunction(() => document.querySelector('.page-actions button')?.disabled === false);
  assert.match(await conflict.innerText(), /版本|刷新/);
  assert.equal(await conflict.locator('li').count(), 0);

  // 学生档案列表读取真实数据
  await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '学生档案', exact: true }).click();
  await page.waitForURL('**/manage/students');
  await page.getByRole('heading', { name: '学生档案' }).waitFor();
  await page.getByLabel('学号或姓名').fill('0000001201');
  await button('查询').click();
  const studentRow = page.getByRole('row', { name: /0000001201/ });
  await studentRow.waitFor();
  assert.match(await studentRow.innerText(), /页面导入学生/);
  assert.match(await studentRow.innerText(), /2026级/);
  assert.match(await studentRow.innerText(), /启用/);
  await pickOption(page, '年级', '2026级');
  await page.waitForURL(url => url.searchParams.get('grade') === '2026');
  assert.equal(new URL(page.url()).searchParams.get('q'), '0000001201');
  await studentRow.waitFor();
  await pickOption(page, '年级', '全部年级');
  await page.waitForURL(url => !url.searchParams.has('grade'));
  await studentRow.waitFor();
  await fits(page);

  // 手机视口不产生横向溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { name: '学生档案' }).waitFor();
  await studentRow.waitFor();
  await fits(page);
  await page.goto(admin + '/manage/imports');
  await page.getByRole('heading', { name: '建档导入' }).waitFor();
  await fits(page);
  // 恢复老师页面的桌面视口，避免影响后续共用该页面的回归。
  await page.setViewportSize({ width: 1440, height: 900 });
}
