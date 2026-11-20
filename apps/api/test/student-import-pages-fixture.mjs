import assert from 'node:assert/strict';
import { buildWorkbook, rosterSheet } from './xlsx-fixture.mjs';

const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const workbook = (rows) =>
  buildWorkbook({ sheets: [rosterSheet(rows)], prefix: true, sharedStrings: true });

/** 老师从后台真实上传名单、按原表行定位错误、修正后确认，并在学生档案中查到新学生。 */
export async function checkStudentImportPages(page, admin, { fits }) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const chip = (text) =>
    page.locator('.page-heading .state-chip').filter({ hasText: text }).first();
  const profile = ['0000001201', '页面导入学生', '本科生', '2026', '0000001301'];
  const invalid = workbook([
    { number: 2, values: profile },
    { number: 3, values: profile, extra: { G: '多余列' } },
  ]);
  const fixed = workbook([{ number: 2, values: profile }]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(admin);
  await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '建档导入', exact: true }).click();
  await page.waitForURL('**/manage/imports');
  await page.getByRole('heading', { name: '建档导入' }).waitFor();
  await page.getByRole('button', { name: '选择或拖入学生建档模板' }).waitFor();

  // 相同资料的第二行在 G 列多填一项：预览必须保留该行错误并阻止确认
  await page.getByLabel('名单文件', { exact: true }).setInputFiles({
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
  assert.equal(await button('确认建档').count(), 0);
  await fits(page);

  // 修正文件后重新上传，待确认批次可确认
  await page.getByLabel('名单文件', { exact: true }).setInputFiles({
    name: '修正名单.xlsx',
    buffer: fixed,
    mimeType,
  });
  await chip('待确认').waitFor();
  await button('确认建档').click();
  await chip('已建档').waitFor();
  await page.getByText('已确认建档，可在学生档案中查到新学生。').waitFor();
  await fits(page);

  // 学生档案列表读取真实数据
  await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '学生档案', exact: true }).click();
  await page.waitForURL('**/manage/students');
  await page.getByRole('heading', { name: '学生档案' }).waitFor();
  await page.getByLabel('学号或姓名').fill('0000001201');
  await button('查询').click();
  const studentRow = page.getByRole('row', { name: /0000001201/ });
  await studentRow.waitFor();
  assert.match(await studentRow.innerText(), /页面导入学生/);
  assert.match(await studentRow.innerText(), /本科生/);
  assert.match(await studentRow.innerText(), /启用/);
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