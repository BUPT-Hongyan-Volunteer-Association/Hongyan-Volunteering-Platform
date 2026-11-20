import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareHourPreviewFixture } from './hour-preview-fixture.mjs';

export async function checkHourPages(page, web, db, sampleId, { pickOption, fits }) {
  const sample = await db.activity.findUniqueOrThrow({
    where: { id: sampleId }, include: { revisions: { orderBy: { revision: 'asc' } } },
  });
  const fixture = await prepareHourPreviewFixture(db, sample);
  const bytes = await fixture.paginatedWorkbook();
  const evidence = process.env.HOUR_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, '合成时长表.xlsx'), bytes);
    await writeFile(resolve(evidence, '修正时长表.xlsx'), fixture.fixed);
  }
  const text = (value) => page.getByText(value, { exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const upload = async (name, buffer) => {
    await page.getByLabel('工作簿', { exact: true }).setInputFiles({
      name, buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await button('上传并预览').click();
  };
  const download = async (label) => {
    const [file] = await Promise.all([page.waitForEvent('download'), button(label).click()]);
    return readFile(await file.path());
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(web + '/managed/' + fixture.activityId);
  await page.getByRole('link', { name: '时长批次', exact: true }).click();
  await text('本活动还没有上传批次。').waitFor();
  await pickOption(page, '导入模式', '更正时长');
  await text('更正绑定原记录的获批安排。').waitFor();
  await pickOption(page, '导入模式', '新增时长');
  await page.getByLabel('工作簿', { exact: true }).setInputFiles({
    name: '表格.csv', mimeType: 'text/csv', buffer: Buffer.from('abcd'),
  });
  await text('请选择不超过 5 MB 的 .xlsx 工作簿。').waitFor();
  assert.ok(await button('上传并预览').isDisabled());
  await pickOption(page, '获批安排', /^版本 1 ·/);
  await upload('合成时长表.xlsx', bytes);
  await text('内容有误').waitFor();
  const originalUrl = page.url();
  const fullTotal = text('全批预计差额：+9.0 小时');
  await fullTotal.waitFor();
  await text('当前条件共 21 行').waitFor();
  assert.equal(await page.locator('tbody tr').count(), 20);
  assert.match(await page.getByRole('row', { name: /^第 2 行 / }).innerText(), /新增/);
  assert.match(await page.getByRole('row', { name: /^第 3 行 / }).innerText(), /重复跳过/);
  await button('下一页').click();
  await text('第 821 行').waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.ok(await fullTotal.isVisible());
  await button('查看 1 行错误').click();
  await text('第 202 行').waitFor();
  assert.ok(await page.getByRole('heading', {name:'逐行核对'}).evaluate(el => el === document.activeElement));
  assert.match(await page.locator('tbody').innerText(), /1\.25/);
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.ok(await fullTotal.isVisible());
  if (evidence) await page.locator('.hour-detail').screenshot({ path: resolve(evidence, '桌面-错误原行.png') });
  const report = await download('下载错误报告');
  if (evidence) await writeFile(resolve(evidence, '错误报告.xlsx'), report);
  assert.deepEqual(await download('下载原工作簿'), bytes);
  await pickOption(page, '行处理方式', '全部动作');
  await page.getByLabel('只看违纪待核实行').check();
  await text('当前条件共 1 行').waitFor();
  await text('第 804 行').waitFor();
  await text('当日预计 25.0 小时').waitFor();
  await text('待核实').waitFor();
  assert.ok(await fullTotal.isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  await fits(page);
  const table = page.locator('.scroll-table');
  const originalX = (await table.locator('tbody th').boundingBox()).x;
  await table.evaluate((element) => {
    const warning = element.querySelector('tbody td:nth-child(6)');
    const rowHeader = element.querySelector('tbody th');
    element.scrollLeft = warning.getBoundingClientRect().left - rowHeader.getBoundingClientRect().right;
    element.scrollIntoView({ block: 'center' });
  });
  assert.ok(await table.evaluate((element) => element.scrollLeft > 0));
  assert.ok(Math.abs((await table.locator('tbody th').boundingBox()).x - originalX) < 2);
  if (evidence) await page.screenshot({ path: resolve(evidence, '手机-违纪与时长警告.png') });
  await button('查看 1 行错误').click();
  await text('第 202 行').waitFor();
  assert.ok(!await page.getByLabel('只看违纪待核实行').isChecked());
  assert.ok(await fullTotal.isVisible());
  await page.reload();
  await fullTotal.waitFor();
  assert.equal(page.url(), originalUrl);
  await button('修正后重传').click();
  // Only the disposable page-test database loses its history table during validation.
  await db.$executeRaw`ALTER TABLE hour_record RENAME TO test_only_unavailable_hour_record`;
  try {
    // The upload commits, but the organizer loses the response and reopens the form.
    await page.route('**/organizer/activities/' + fixture.activityId + '/hour-imports', async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      await route.abort('failed');
    }, { times: 1 });
    await upload('修正时长表.xlsx', fixture.fixed);
    await page.locator('.hour-form [role="alert"]').waitFor();
    await button('收起上传表单').click();
    await button('修正后重传').click();
    await upload('修正时长表.xlsx', fixture.fixed);
    await text('系统校验失败').waitFor();
    assert.equal(await db.hourImportBatch.count({ where: { activity_id: fixture.activityId } }), 2);
  } finally {
    await db.$executeRaw`ALTER TABLE test_only_unavailable_hour_record RENAME TO hour_record`;
  }
  const retryUrl = page.url();
  assert.notEqual(retryUrl, originalUrl);
  await button('重试原批次').click();
  await text('校验完成').waitFor();
  await text('全批预计差额：+10.2 小时').waitFor();
  assert.equal(await button('查看 1 行错误').count(), 0);
  assert.equal(page.url(), retryUrl);
  await page.getByRole('link', { name: '查看修正前批次' }).click();
  await fullTotal.waitFor();
  assert.equal(page.url(), originalUrl);
  await page.getByRole('link', { name: '返回时长批次' }).click();
  await page.getByRole('link', { name: '修正时长表.xlsx' }).waitFor();
  await pickOption(page, '获批安排', /^版本 1 ·/);
  await upload('旧六列.xlsx', fixture.legacyWorkbook(2));
  await text('校验完成').waitFor();
  await text('全批预计差额：+3.2 小时').waitFor();
  await text('当前条件共 2 行').waitFor();
  assert.equal(await page.getByRole('cell', { name: '未提供', exact: true }).count(), 2);
  await db.activityMember.delete({ where: { activity_id_account_id: {
    activity_id: fixture.activityId, account_id: fixture.ownerId,
  } } });
  await page.getByLabel('只看违纪待核实行').check();
  await page.locator('.hour-detail').waitFor({ state: 'detached' });
  await page.getByRole('alert').first().waitFor();
  assert.equal(await button('下载原工作簿').count(), 0);
}
