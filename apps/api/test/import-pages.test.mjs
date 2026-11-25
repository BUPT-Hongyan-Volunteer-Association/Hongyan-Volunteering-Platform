import test from 'node:test';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { checkHourPages } from './hour-pages-fixture.mjs';
import { checkStudentImportPages } from './student-import-pages-fixture.mjs';
import { checkLedgerPages } from './hour-ledger-pages.mjs';

import { withPages, pickOption, holdResponse, settleRender, capture, fits } from './page-environment.mjs';

test('建档、时长导入与账务办理', { timeout: 10 * 60_000 }, async t => {
  await withPages(t, async ({ web, admin, api, student, owner, helper, teacher, db, first }) => {
    await t.test('老师从后台导入学生名单并在学生档案中查到新学生', async () => {
      await checkStudentImportPages(teacher, admin, { fits, pickOption, db, holdResponse });
    });

    await t.test('负责人上传并逐行核对时长、下载报告、修正重传和原批重试', async () => {
      await checkHourPages(owner, web, db, first.id, { pickOption, fits });
    });

    await t.test('四个账号完成真实送审、入账、错帐修复和分别结案，逐行审核跨页保留意见', async () => {
      await checkLedgerPages({ db, web, admin, owner, teacher, student, secondStudent: helper,
        worker: api.get(NoticeWorker), fits, pickOption, capture, holdResponse, settleRender });
    });
  });
});
