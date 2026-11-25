import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { demoActivities } from '../scripts/demo-scenarios.mjs';
import {
  withPages, loginFailureMessage, link, button, accountSecurity, visible, chooseDate, pickOption, signIn, fits,
} from './page-environment.mjs';

test('账号身份、角色授权、登录与凭证办理', { timeout: 5 * 60_000 }, async t => {
  await withPages(t, async ({ password, web, admin, browser, student, owner, helper, teacher, tech, db }) => {
    const numbers = ['0190000001', '0190000002'];
    for (const username of numbers) await db.account.create({ data: {
      username, display_name: '合成同名', password_hash: 'fixture',
      roles: { create: { role: 'student' } }, student: { create: { student_no: username } },
    } });
    await t.test('按学号核对同名账号，核对身份过程中仅发送读取请求', async () => {
      const writes = [];
      const collect = (r) => {
        if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(r.method());
      };
      for (const p of [teacher, tech]) p.on('request', collect);
      const staff = await db.account.findUniqueOrThrow({ where: { username: 'demo.admin' } });
      await teacher.goto(admin + '/');
      await link(teacher, '账号与角色').click();
      const input = teacher.getByLabel('学生学号');
      const card = teacher.getByRole('region', { name: '账号核对结果' });
      for (const number of numbers) {
        await input.fill(number);
        assert.equal(await card.count(), 0);
        await button(teacher, '查询账号').click();
        await visible(card.getByText(number, {exact:true}));
        await visible(card.getByRole('heading', {name:'合成同名'}));
      }
      await input.fill('0999999999');
      await button(teacher, '查询账号').click();
      await visible(teacher.getByText('没有找到可查看的账号，请核对学号'));
      assert.equal(await card.count(), 0);
      await teacher.goto(admin + '/manage/accounts/' + staff.id);
      await visible(teacher.getByText('没有找到可查看的账号'));
      await tech.goto(admin + '/manage/accounts/' + staff.id);
      await visible(tech.getByRole('heading', {name: staff.display_name}));
      await visible(tech.getByText('技术管理员', {exact:true}));
      await accountSecurity(tech).click();
      await button(tech, '停用账号').click();
      await visible(tech.getByText('停用账号 · ' + staff.display_name + '（' + staff.username + '）', { exact: true }));
      assert.ok(await button(tech, '确认停用').isDisabled());
      assert.deepEqual(writes, []);
      for (const p of [teacher, tech]) p.off('request', collect);
    });
    await t.test('洛杉矶设备按北京时间筛选和核对审计明细', async () => {
      const actor = await db.account.findUniqueOrThrow({ where: { username: 'demo.teacher' } });
      const resourceId = randomUUID();
      const record = { actor_id: actor.id, resource_type: 'student', action: 'update_student', resource_id: resourceId };
      await db.auditEvent.createMany({ data: [
        { ...record, created_at: new Date('2026-11-03T00:59:00Z'), reason: '北京上午九点之前' },
        { ...record, created_at: new Date('2026-11-03T01:00:00Z'), reason: '北京上午九点整', after: {grade:'2026'} },
        { ...record, created_at: new Date('2026-11-04T01:01:00Z'), reason: '结束窗口之后' },
      ] });
      const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', ignoreHTTPSErrors: true,
        storageState: await teacher.context().storageState() });
      try {
        const audit = await context.newPage();
        await audit.goto(admin + '/manage/audit');
        assert.equal(await audit.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/Los_Angeles');
        await audit.getByLabel('对象 ID').fill(resourceId);
        await chooseDate(audit, '起始时间日期', '2026-11-03');
        await chooseDate(audit, '结束时间日期', '2026-11-04');
        const response = audit.waitForResponse(r => r.url().includes('/admin/audit-events?') && r.url().includes(resourceId));
        await button(audit, '查询').click();
        const result = await response, params = new URL(result.url()).searchParams;
        assert.equal(params.get('from'), '2026-11-03T01:00:00.000Z');
        assert.equal(params.get('to'), '2026-11-04T01:00:00.000Z');
        assert.equal((await result.json()).data.total, 1);
        const row = audit.getByRole('row').filter({hasText:'北京上午九点整'});
        await visible(row.getByText('更新学生档案'));
        assert.match(await row.locator('time').innerText(), /09:00/);
        await row.getByText('查看变更').click();
        await visible(row.getByText(resourceId));
        await visible(row.locator('pre').filter({hasText:'2026'}));
        await audit.reload();
        await visible(audit.getByRole('row').filter({hasText:'北京上午九点整'}));
      } finally { await context.close(); }
    });

    await t.test('技术管理员核对后建后台账号，老师保留学生建档入口', async () => {
      await teacher.goto(admin + '/manage/accounts');
      await visible(link(teacher, '导入学生名单建档'));
      assert.equal(await teacher.getByText('创建后台账号', { exact: true }).count(), 0);
      await tech.goto(admin + '/');
      await link(tech, '账号与角色').click();
      await tech.getByText('创建后台账号', { exact: true }).click();
      await tech.getByLabel('新账号登录名').fill('faculty.demo');
      await tech.getByLabel('姓名', { exact: true }).fill('合成教师');
      await pickOption(tech, '后台角色', '老师审核员');
      await tech.getByLabel('创建原因').fill('合成验收');
      await button(tech, '核对创建信息').click();
      await visible(tech.getByRole('heading', { name: '核对后台账号' }));
      assert.equal(await db.account.count({ where: { username: 'faculty.demo' } }), 0);
      await button(tech, '确认创建').click();
      await visible(tech.getByText('已创建 faculty.demo，待发放初始凭证'));
      await pickOption(tech, '筛选角色', '老师审核员');
      await pickOption(tech, '筛选账号状态', '启用');
      await link(tech, '合成教师 · faculty.demo').click();
      await visible(tech.getByText('待发放，暂不可登录'));
      await accountSecurity(tech).click();
      await button(tech, '签发临时凭证').click();
      const temporary = await tech.getByLabel('临时凭证', { exact: true }).inputValue();
      await tech.getByLabel('签发原因').fill('本人已核验');
      await tech.getByLabel('我已人工核验申请人本人，并核对上述账号').check();
      await button(tech, '确认签发').click();
      await visible(tech.getByText('临时凭证已签发，首次登录须修改密码'));
      const faculty = await signIn(browser, admin, 'faculty.demo', 'F9' + randomUUID(), 1440, temporary);
      await visible(link(faculty, '账号与角色'));
      await faculty.context().close();
      await link(tech, '返回账号查询').click();
      assert.equal(new URL(tech.url()).searchParams.get('role'), 'reviewer');
      assert.equal(new URL(tech.url()).searchParams.get('status'), 'active');
      await tech.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '合成教师 · faculty.demo');
      await tech.getByLabel('登录账号', { exact: true }).fill('faculty.demo');
      await button(tech, '查询账号').click();
      await visible(tech.getByRole('heading', { name: '合成教师' }));
    });
    await t.test('管理员办理限期技术角色、收回授权，并看到最后一名长期管理员保护提示', async () => {
      await tech.goto(admin + '/manage/accounts');
      await teacher.goto(admin + '/manage/accounts');
      const lookup = async username => {
        await tech.getByLabel('登录账号', { exact: true }).fill(username);
        await button(tech, '查询账号').click();
        await pickOption(tech, '要办理的角色', '技术管理员');
      };
      await lookup('demo.teacher');
      await button(tech, '授予技术管理员角色').click();
      await visible(tech.getByText('长期授权没有到期日', { exact: false }));
      await tech.getByLabel('限期授权').check();
      await chooseDate(tech, '到期时间日期', '2099-12-31');
      await tech.getByLabel('办理原因').fill('代班期间维护账号');
      await button(tech, '保存技术管理员角色').click();
      await visible(tech.getByText('技术管理员角色已保存'));
      await button(tech, '调整有效期').click();
      assert.match(await button(tech, '到期时间日期').innerText(), /2099-12-31/);
      assert.equal(await tech.getByRole('combobox', { name: '到期时间时分' }).inputValue(), '09:00');
      await button(tech, '取消').click();
      await teacher.reload();
      await visible(teacher.getByText('创建后台账号', { exact: true }));
      const teacherAccount = await db.account.findUniqueOrThrow({ where: { username: 'demo.teacher' } });
      await db.roleGrant.update({ where: { account_id_role: { account_id: teacherAccount.id, role: 'tech_admin' } },
        data: { expires_at: new Date(0) } });
      await lookup('demo.teacher');
      await visible(tech.getByText(/已到期 · /));
      await button(tech, '收回技术管理员角色').click();
      await tech.getByLabel('办理原因').fill('代班结束');
      await button(tech, '确认收回技术管理员角色').click();
      await visible(tech.getByText('技术管理员角色已收回'));
      await teacher.reload();
      await visible(teacher.getByLabel('学生学号'));
      assert.equal(await teacher.getByText('创建后台账号', { exact: true }).count(), 0);
      await lookup('demo.admin');
      await button(tech, '调整有效期').click();
      await tech.getByLabel('限期授权').check();
      await chooseDate(tech, '到期时间日期', '2099-12-31');
      await tech.getByLabel('办理原因').fill('核对长期管理员保护');
      await button(tech, '保存技术管理员角色').click();
      await visible(tech.getByRole('alert').filter({ hasText: '须保留至少一个可登录' }));
      await fits(tech);
    });
    await t.test('技术管理员停启独立账号，老师原窗口需重新登录', async () => {
      const affected = await signIn(browser, admin, 'demo.dual', password, 390);
      await tech.goto(admin + '/manage/accounts');
      await tech.getByLabel('登录账号', { exact: true }).fill('demo.dual');
      await button(tech, '查询账号').click();
      await accountSecurity(tech).click();
      await button(tech, '停用账号').click();
      await visible(tech.getByText('停用账号 · 兼任审核员（demo.dual）'));
      await tech.getByLabel('办理原因').fill('轮岗交接');
      await button(tech, '确认停用').click();
      await visible(tech.getByText('账号已停用，所有旧会话已撤销'));
      await affected.reload();
      await visible(button(affected, '登录'));
      await accountSecurity(tech).click();
      await button(tech, '启用账号').click();
      await tech.getByLabel('办理原因').fill('恢复履职');
      await button(tech, '确认启用').click();
      await visible(tech.getByText('账号已启用'));
      await affected.reload();
      await visible(button(affected, '登录'));
      await affected.getByLabel('账号', { exact: true }).fill('demo.dual');
      await affected.getByLabel('当前密码').fill(password);
      await button(affected, '登录').click();
      await visible(button(affected, '退出登录'));
      await tech.getByLabel('登录账号', { exact: true }).fill('demo.admin');
      await button(tech, '查询账号').click();
      await accountSecurity(tech).click();
      await button(tech, '停用账号').click();
      await tech.getByLabel('办理原因').fill('核对最后一个管理员');
      await button(tech, '确认停用').click();
      await visible(tech.getByRole('alert').filter({ hasText: '须保留至少一个可登录' }));
      await affected.context().close();
    });
    await t.test('老师按身份卡授权与收回，学生原会话保留学生入口', async () => {
      await teacher.goto(admin + '/manage/accounts');
      const input = teacher.getByLabel('学生学号');
      await input.fill('0000000001');
      await button(teacher, '查询账号').click();
      await button(teacher, '授予负责人资格').click();
      await teacher.getByLabel('办理原因').fill('不应带到下个账号');
      await input.fill('0190000002');
      await button(teacher, '查询账号').click();
      await button(teacher, '授予负责人资格').click();
      assert.equal(await teacher.getByLabel('办理原因').inputValue(), '');
      for (const width of [390, 1440]) {
        await teacher.setViewportSize({ width, height: 900 });
        await input.fill('0000000001');
        await button(teacher, '查询账号').click();
        const grant = button(teacher, '授予负责人资格');
        await visible(grant);
        const action = await grant.boundingBox();
        const security = await accountSecurity(teacher).boundingBox();
        assert.ok(action.y + action.height <= security.y);
        assert.equal(await button(teacher, '重置登录凭证').isVisible(), false);
        assert.equal(await button(teacher, '停用账号').isVisible(), false);
        await fits(teacher);
        await grant.click();
        await teacher.getByLabel('限期授权').check();
        await chooseDate(teacher, '到期时间日期', '2099-06-30');
        await teacher.getByLabel('办理原因').fill('合成志愿服务授权');
        await button(teacher, '保存负责人资格').click();
        await visible(teacher.getByText('负责人资格已保存，本次操作不会分配活动'));
        await visible(teacher.getByText(/有效至.*09:00/));
        await visible(button(teacher, '调整有效期'));
        await student.goto(web + '/managed');
        await visible(student.getByRole('heading', {name:'我的管理活动'}));
        await button(teacher, '收回负责人资格').click();
        await visible(teacher.getByText(/学生身份和历史记录保留/));
        await teacher.getByLabel('办理原因').fill('合成授权结束');
        await button(teacher, '确认收回资格').click();
        await visible(teacher.getByText('已收回负责人资格，学生身份保留'));
      }
      await student.reload();
      await visible(student.getByText('当前账号无活动管理权限'));
      await student.goto(web + '/mine');
      await visible(button(student, '退出登录'));
    });

    await t.test('会话到期后在原表单重试，兼任负责人保留管理入口', async () => {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(12000);
        await page.goto(web);
        await page.getByLabel('账号', { exact: true }).fill('demo.dual');
        await page.getByLabel('当前密码').fill(password);
        await ctx.clearCookies();
        await button(page, '登录').click();
        await visible(page.getByText('登录页面已过期，会话已更新，请再次登录'));
        await page.getByLabel('当前密码').fill('wrong-password');
        await button(page, '登录').click();
        await visible(page.getByText(loginFailureMessage, { exact: true }));
        await page.getByLabel('当前密码').fill(password);
        await button(page, '登录').click();
        await visible(button(page, '退出登录'));
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await visible(link(page, width === 390 ? '管理' : '我的管理活动'));
          for (const label of ['我的报名', '通知', '我的'])
            assert.equal(await link(page, label).count(), 0);
        }
        await link(page, '管理').click();
        await visible(page.getByRole('heading', {name:'我的管理活动'}));
        await link(page, '活动发现').click();
        await link(page, demoActivities.open.title).click();
        assert.equal(await link(page, '我的报名').count(), 0);
        assert.equal(await button(page, '申请报名').isEnabled(), false);
        await page.goto(web + '/registrations');
        await visible(page.getByRole('alert').filter({ hasText: '当前账号无学生个人页面权限' }));
      } finally {
        await ctx.close();
      }
    });

    await t.test('老师核对姓名学号并确认本人后重置，负责人旧窗口退出', async () => {
      await teacher.goto(admin + '/manage/accounts');
      await teacher.getByLabel('学生学号').fill('0000000002');
      await button(teacher, '查询账号').click();
      await accountSecurity(teacher).click();
      await button(teacher, '重置登录凭证').click();
      await visible(teacher.getByText('重置登录凭证 · 同学甲（0000000002）'));
      const confirmed = teacher.getByLabel('我已人工核验申请人本人，并核对上述账号');
      await teacher.getByLabel('重置原因').fill('本人申请重置');
      assert.equal(await button(teacher, '确认重置').isDisabled(), true);
      await confirmed.check();
      await button(teacher, '确认重置').click();
      await visible(teacher.getByText('旧凭证和登录会话已失效，新凭证待发放'));
      await visible(teacher.getByText('待发放，暂不可登录'));
      await owner.reload();
      await visible(button(owner, '登录'));
      await owner.getByLabel('账号', { exact: true }).fill('0000000002');
      await owner.getByLabel('当前密码').fill(password);
      await button(owner, '登录').click();
      await visible(owner.getByText(loginFailureMessage, { exact: true }));
    });
    await t.test('从我的账号管理核验原密码，沿用密码规则并轮换会话', async () => {
      const username = '0000000004', replacement = 'A9' + randomUUID().slice(0, 6);
      await helper.goto(web);
      await link(helper, '我的').click();
      await link(helper, '账号管理').click();
      const current = helper.getByLabel('原密码'), next = helper.getByLabel('新密码');
      const save = button(helper, '保存新密码');
      await current.fill('填写错误的原密码');
      await next.fill(replacement);
      await save.click();
      await visible(helper.getByRole('alert').filter({ hasText: '当前密码不正确' }));
      await current.fill(password);
      for (const weak of ['abc1234', 'abcdefgh', '12345678']) {
        await next.fill(weak);
        const response = helper.waitForResponse(r => r.url().endsWith('/auth/change-password'));
        await save.click();
        assert.equal((await response).status(), 422);
      }
      const oldSession = await signIn(browser, web, username, password, 1440, null);
      try {
        await next.fill(replacement);
        let csrfReads = 0;
        const trackCsrf = request => { if (request.url().endsWith('/auth/csrf')) csrfReads++; };
        helper.on('request', trackCsrf);
        await save.click();
        await visible(helper.getByRole('status').filter({ hasText: '密码已更改' }));
        helper.off('request', trackCsrf);
        assert.equal(csrfReads, 0);
        assert.equal(await current.inputValue(), '');
        assert.equal(await next.inputValue(), '');
        await oldSession.reload();
        await visible(button(oldSession, '登录'));
        const logout = helper.waitForResponse(response => response.url().endsWith('/auth/logout'));
        await button(helper, '退出登录').click();
        assert.equal((await logout).status(), 200);
        await helper.getByLabel('账号', { exact: true }).fill(username);
        await helper.getByLabel('当前密码').fill(password);
        await button(helper, '登录').click();
        await visible(helper.getByText(loginFailureMessage, { exact: true }));
        await helper.getByLabel('当前密码').fill(replacement);
        await button(helper, '登录').click();
        await visible(helper.getByRole('heading', { name: '账号管理' }));
      } finally { await oldSession.context().close(); }
    });
  });
});
