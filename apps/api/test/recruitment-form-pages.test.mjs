import test from 'node:test';
import assert from 'node:assert/strict';
import { button, chooseDate, fits, holdResponse, link, openOptions, pickOption, settleRender, shiftDay, visible, withPages } from './page-environment.mjs';

test('负责人编辑三类问卷，教师审核，学生分岗作答，按版本筛选和办理报名', async t => {
  await withPages(t, async ({ db, owner, student, helper, joined, teacher, admin, web }) => {
    const title = '天文馆分岗问卷体验';
    const questionTitle = '是否有讲解经验，能够面向不同年龄段的读者介绍天文展品、安排参观路线，并在团队到场前独立完成设备检查？';
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0,10);
    const day = shiftDay(today, 3);
    await owner.setViewportSize({width:1440,height:900});
    await owner.goto(web + '/managed');
    await link(owner,'新建活动').click();
    for (const [field, value] of Object.entries({
      活动标题:title, 服务对象:'到馆读者', 服务内容:'引导参观', 活动地点:'天文馆', 集合地点:'南门',
      交通说明:'步行到馆', '联系方式 1':'馆内服务台', 入群方式:'请联系负责人',
      时长认定说明:'按实际服务时长认定', 注意事项:'请携带学生证', 相关说明:'提前十分钟集合',
    })) await owner.getByLabel(field, {exact:true}).fill(value);
    await pickOption(owner,'校区','沙河校区');
    for (const [field, date] of [
      ['活动开始日期', day], ['活动结束日期', day], ['报名开放日期', shiftDay(today,-1)],
      ['报名截止日期', shiftDay(today,1)], ['预计时长导入日期', shiftDay(day,1)],
    ]) await chooseDate(owner,field,date);
    await pickOption(owner,'报名方式','分批报名');
    await owner.getByLabel('允许多岗').check();
    const roles = ['讲解岗', '签到岗', '布展岗', '咨询岗'];
    for (const [index, role] of roles.entries()) {
      await button(owner,'添加报名项').click();
      const item = owner.getByRole('group',{name:'报名项 ' + (index + 1),exact:true});
      await item.getByLabel('第 ' + (index + 1) + ' 项岗位').fill(role);
      await item.getByLabel('服务开始').fill(day + 'T09:00');
      await item.getByLabel('服务结束').fill(day + 'T11:00');
      await item.getByLabel('候补人数').fill('1');
    }
    const questions = [
      [questionTitle, '单选题', ['有经验','初次参加']],
      ['熟悉的任务', '多选题', ['接待','记录']],
      ['备注', '填空题', []],
    ];
    for (const [index, [question, type, options]] of questions.entries()) {
      const prefix = '第 ' + (index + 1) + ' 题';
      await button(owner,'添加题目').click();
      if (type !== '单选题') await pickOption(owner,prefix + '题型',type);
      if (index > 0) await owner.getByLabel(prefix + '题目').fill(question);
      for (const [n, label] of options.entries()) await owner.getByLabel(prefix + '选项 ' + (n + 1)).fill(label);
    }
    await owner.getByRole('group',{name:'第 1 题',exact:true}).getByLabel('题目说明').fill('请考虑以往的服务经历');
    await button(owner,'保存草稿').click();
    await owner.waitForURL(/managed\/[\w-]+\/edit/);
    const editUrl = owner.url();
    const activityId = new URL(editUrl).pathname.split('/')[2];
    await button(owner,'提交审核').click();
    const validation = owner.getByRole('list',{name:'待修正字段'});
    await visible(validation);
    assert.match(await validation.innerText(), /第 1 题 \/ 题目 · 请填写题目/);
    await owner.getByLabel('第 1 题题目').fill(questionTitle);
    await button(owner,'保存草稿').click();
    await visible(owner.getByText('草稿已保存',{exact:true}));
    async function approve(expected, editor = owner, previousDescription) {
      await button(editor,'提交审核').click();
      await visible(editor.getByText('已送审，内容已冻结',{exact:true}));
      await teacher.goto(admin + '/reviews');
      await teacher.getByRole('link',{name:new RegExp(title)}).click();
      const snapshot = teacher.locator('.review-detail details').filter({has:teacher.locator('summary',{hasText:'冻结内容'})}).first();
      if (await snapshot.getAttribute('open') === null)
        await snapshot.locator('summary').first().click();
      const questionText = await snapshot.getByText('报名问卷', {exact:true}).locator('+ dd').innerText();
      for (const text of expected) assert.ok(questionText.includes(text), text);
      if (previousDescription) {
        const diff = teacher.locator('.diff dt').filter({hasText:'报名问卷'}).locator('+ dd');
        assert.ok((await diff.locator('span').innerText()).includes('题目说明　' + previousDescription));
        assert.ok((await diff.locator('strong').innerText()).includes(expected[0]));
      }
      await button(teacher,'批准发布').click();
      await visible(teacher.getByText('已批准发布',{exact:true}));
    }
    await approve(['题目　' + questionTitle, '题目说明　请考虑以往的服务经历', '单选题','多选题','填空题','有经验','接待','备注']);
    await owner.goto(web + '/managed');
    await link(owner,title).click();
    const nav = owner.getByRole('navigation',{name:'活动工作区'});
    await link(nav,'报名名单').click();
    await visible(owner.locator('.capacity'));
    const heading = await owner.getByRole('heading',{name:'报名名单'}).boundingBox();
    const capacity = await owner.locator('.capacity').boundingBox();
    assert.ok(capacity.x >= heading.x && capacity.x < heading.x + heading.width + 40);
    const segments = await owner.locator('.status-options').boundingBox();
    const select = await owner.locator('.status-filters .el-select__wrapper').boundingBox();
    assert.ok(Math.abs(segments.y + segments.height - select.y - select.height) < 2);
    // A published form without submissions disappears from the version selector after revision.
    await button(owner,'按答卷筛选').click();
    await pickOption(owner,'筛选答案','有经验');
    await visible(owner.getByText('暂无匹配的报名'));
    const editor = await owner.context().newPage();
    try {
      await editor.goto(editUrl);
      await editor.getByRole('group',{name:'第 1 题',exact:true}).getByLabel('题目说明').fill('请选择最符合实际的一项');
      await button(editor,'保存草稿').click();
      await visible(editor.getByText('草稿已保存',{exact:true}));
      await approve(['题目说明　请选择最符合实际的一项'], editor, '请考虑以往的服务经历');
      await visible(owner.getByText('问卷已更新，原筛选条件已清除。',{exact:true}));
      assert.equal(await owner.getByRole('combobox',{name:'筛选答案'}).count(),0);
      await visible(button(owner,'按答卷筛选'));
    } finally { await editor.close(); }
    await student.goto(web);
    await link(student,title).click();
    await visible(student.getByText('请携带学生证'));
    await visible(student.getByText('提前十分钟集合'));
    const signup = student.locator('form.signup');
    await signup.getByRole('checkbox',{name:/讲解岗/}).check();
    await signup.getByRole('checkbox',{name:/签到岗/}).check();
    await button(student,'申请报名').click();
    await visible(student.getByRole('alert').filter({hasText:'是否有讲解经验'}));
    await visible(signup.getByText('请选择最符合实际的一项',{exact:true}));
    await signup.getByRole('radio',{name:'初次参加'}).check();
    await signup.getByRole('radio',{name:'有经验'}).check();
    assert.equal(await signup.getByRole('radio',{name:'初次参加'}).isChecked(), false);
    await button(student,'申请报名').click();
    await visible(signup.getByRole('alert').filter({hasText:'熟悉的任务'}));
    await signup.getByRole('checkbox',{name:'接待',exact:true}).check();
    await signup.getByRole('checkbox',{name:'记录',exact:true}).check();
    await button(student,'申请报名').click();
    await visible(signup.getByRole('alert').filter({hasText:'备注'}));
    assert.equal(await db.registration.count({where:{activity_id:activityId}}), 0);
    await signup.getByRole('textbox',{name:'备注'}).fill('可使用英文接待');
    await fits(student);
    await button(student,'申请报名').click();
    await visible(student.getByText('已提交 2 项报名',{exact:true}));
    await visible(owner.getByText('共 2 人次、1 人',{exact:false}));
    await signup.getByRole('checkbox',{name:/布展岗/}).check();
    await visible(student.getByText('已提交本版问卷，补报时共用这份答卷'));
    await button(student,'申请报名').click();
    await visible(owner.getByText('共 3 人次、1 人',{exact:false}));
    const studentCount = await db.questionnaireResponse.count({where:{activity_id:activityId}});
    assert.equal(studentCount,1);
    await button(owner,'按答卷筛选').click();
    const selectedQuestion = owner.locator('.question-filter');
    for (const width of [320, 390, 1440]) {
      await owner.setViewportSize({width, height:900});
      await settleRender(owner);
      assert.equal(await selectedQuestion.getByRole('combobox').getAttribute('aria-expanded'), 'false');
      const shown = await selectedQuestion.evaluate(control => {
        const label = control.querySelector('.el-select__placeholder span');
        const range = document.createRange();
        range.selectNodeContents(label);
        const box = control.getBoundingClientRect();
        return { text: label.textContent, visible: [...range.getClientRects()].every(line =>
          line.left >= box.left && line.right <= box.right + 1 && line.top >= box.top && line.bottom <= box.bottom + 1) };
      });
      assert.deepEqual(shown, {text:questionTitle + '（单选）', visible:true});
      await fits(owner);
    }
    await pickOption(owner,'筛选题目','备注（填空）');
    await owner.getByRole('searchbox',{name:'答案关键词'}).fill('不存在');
    await visible(owner.getByText('暂无匹配的报名'));
    await owner.getByRole('searchbox',{name:'答案关键词'}).fill('英文');
    await visible(owner.getByText('共 3 人次、1 人',{exact:false}));
    const firstRow = owner.locator('tbody tr').filter({hasText:'讲解岗'});
    await firstRow.getByRole('button',{name:/查看/}).click();
    const answerDetail = page => page.getByRole('region',{name:'报名答卷'});
    const answerValues = async (page, expected) => {
      const answers = answerDetail(page);
      await visible(answers);
      assert.deepEqual(await answers.locator('details[open] dt').allTextContents(), [questionTitle,'熟悉的任务','备注']);
      assert.deepEqual(await answers.locator('details[open] dd').allTextContents(), expected);
    };
    const firstAnswers = ['有经验','接待、记录','可使用英文接待'];
    await answerValues(owner, firstAnswers);
    await button(owner,'录取此人').click();
    await visible(owner.getByText('已录取体验学生',{exact:true}));
    await button(owner,'已录取 1').click();
    await visible(owner.getByText('共 1 人次、1 人',{exact:false}));
    await firstRow.getByRole('button',{name:/查看/}).click();
    await answerValues(owner, firstAnswers);
    await link(student.locator('.activity-detail'),'我的报名').click();
    const registration = student.locator('.summary-list li').filter({hasText:'讲解岗'});
    await visible(registration.getByText('已录取',{exact:true}));
    await link(registration,'办理与进度').click();
    await answerValues(student, firstAnswers);
    await student.getByLabel('申请原因').fill('需要退出这一岗');
    await button(student,'申请退出该报名项').click();
    await visible(button(student,'撤回退出申请'));
    await link(nav,'退出与恢复').click();
    const requestTabs = owner.getByRole('navigation',{name:'申请类型'});
    for (const kind of ['退出申请','恢复申请','退出申请']) {
      await link(requestTabs,kind).click();
      await visible(requestTabs.locator('a.current').filter({hasText:kind}));
      assert.equal(await requestTabs.locator('a[aria-current="page"]').count(),1);
      assert.equal(await requestTabs.locator('.router-link-exact-active').count(),0);
    }
    await owner.getByRole('link',{name:/处理申请 · 体验学生/}).click();
    await button(owner,'批准退出').click();
    await visible(owner.getByText('退出申请已批准',{exact:true}));
    await student.goto(web + '/registrations');
    await visible(student.locator('.summary-list li').filter({hasText:'讲解岗'}).getByText('已退出',{exact:true}));
    await visible(student.locator('.summary-list li').filter({hasText:'签到岗'}).getByText('已提交，待审核',{exact:true}));

    // Change one option's meaning while another student has the previous form open.
    await helper.goto(web);
    await link(helper, title).click();
    const other = helper.locator('form.signup');
    await other.getByRole('checkbox', {name:/讲解岗/}).check();
    await other.getByRole('checkbox', {name:/咨询岗/}).check();
    await other.getByRole('radio', {name:'有经验'}).check();
    await other.getByRole('checkbox', {name:'接待',exact:true}).check();
    await other.getByRole('textbox', {name:'备注'}).fill('保留这段内容');
    await owner.goto(editUrl);
    await owner.getByLabel('第 1 题选项 1').fill('仅限周日');
    await owner.getByRole('group',{name:'报名项 4',exact:true}).getByLabel('服务开始').fill(day + 'T09:30');
    await button(owner,'保存草稿').click();
    await visible(owner.getByText('草稿已保存',{exact:true}));
    await approve(['仅限周日']);
    await button(helper,'申请报名').click();
    await visible(other.getByText('报名项目和问卷已更新，请重新选择变更的项目并复核答案'));
    assert.equal(await other.getByRole('checkbox', {name:/咨询岗/}).isChecked(), false);
    assert.equal(await other.getByRole('checkbox', {name:/讲解岗/}).isChecked(), true);
    assert.equal(await db.registration.count({where:{activity_id:activityId,item_label:{startsWith:'咨询岗'}}}),0);
    assert.equal(await other.getByRole('textbox',{name:'备注'}).inputValue(), '保留这段内容');
    assert.ok(await other.getByRole('checkbox',{name:'接待',exact:true}).isChecked());
    assert.ok(!await other.getByRole('radio',{name:'仅限周日'}).isChecked());
    await other.getByRole('radio',{name:'仅限周日'}).check();
    await button(helper,'申请报名').click();
    await visible(other.getByText('已提交 1 项报名'));
    await joined.goto(web);
    await link(joined,title).click();
    const third = joined.locator('form.signup');
    await third.getByRole('checkbox',{name:/咨询岗/}).check();
    await third.getByRole('radio',{name:'仅限周日'}).check();
    await third.getByRole('checkbox',{name:'记录',exact:true}).check();
    await third.getByRole('textbox',{name:'备注'}).fill('擅长核对书号');
    await button(joined,'申请报名').click();
    await visible(third.getByText('已提交 1 项报名'));
    await link(nav, '报名名单').click();
    const count = (items, people) => visible(owner.getByText('共 ' + items + ' 人次、' + people + ' 人', {exact:false}));
    const inspectStudent = async (number, expected) => {
      await owner.getByRole('row').filter({has:owner.getByRole('cell',{name:number,exact:true})})
        .first().getByRole('button',{name:/查看/}).click();
      await answerValues(owner, expected);
      await button(owner,'收起记录').click();
    };
    await count(4,3);
    await inspectStudent('0000000004', ['仅限周日','接待','保留这段内容']);
    await inspectStudent('0000000003', ['仅限周日','记录','擅长核对书号']);
    await button(owner, '按答卷筛选').click();
    await pickOption(owner, '筛选答案', '仅限周日');
    await count(2,2);
    async function pickRule(index, label, value) {
      const input = owner.getByRole('combobox',{name:label,exact:true}).nth(index);
      await input.press('Enter');
      const options = owner.locator('#' + (await input.getAttribute('aria-controls')));
      await options.getByRole('option',{name:value,exact:true}).click();
      await options.waitFor({state:'hidden'});
    }
    await button(owner,'添加答卷条件').click();
    await pickRule(1,'筛选题目','熟悉的任务（多选）');
    await pickRule(1,'筛选答案','记录');
    await count(1,1);
    await visible(owner.getByRole('cell', {name:'0000000003', exact:true}));
    await button(owner,'添加答卷条件').click();
    await pickRule(2,'筛选题目','备注（填空）');
    const keyword = owner.getByRole('searchbox',{name:'答案关键词'});
    await keyword.fill('保留');
    await visible(owner.getByText('暂无匹配的报名'));
    await keyword.fill('书号');
    await count(1,1);
    for (let i = 0; i < 3; i++) await button(owner,'移除条件').last().click();
    await count(4,3);
    await button(owner,'按答卷筛选').click();
    const versions = await openOptions(owner, '筛选问卷版本');
    await versions.list.getByRole('option', {name:/历史问卷/}).click();
    await pickOption(owner, '筛选答案', '有经验');
    await visible(owner.getByText('共 2 人次、1 人', {exact:false}));
    assert.equal(await owner.getByRole('cell', {name:'0000000004', exact:true}).count(), 0);
    assert.equal(await owner.getByRole('cell', {name:'0000000001', exact:true}).count(), 2);
    await inspectStudent('0000000001', firstAnswers);
    await button(owner,'移除条件').click();
    await count(4,3);

    // One student's reapplication replaces the current response for this item and retains its first submission.
    const secondItem = student.locator('.summary-list li').filter({hasText:'签到岗'});
    await link(secondItem,'办理与进度').click();
    await button(student,'撤回报名').click();
    await visible(student.getByText('已撤回报名',{exact:true}));
    await link(student,'查看活动详情').click();
    await signup.getByRole('checkbox',{name:/签到岗/}).check();
    await signup.getByRole('radio',{name:'初次参加'}).check();
    await signup.getByRole('checkbox',{name:'记录',exact:true}).check();
    await signup.getByRole('textbox',{name:'备注'}).fill('这次可在服务台值班');
    await button(student,'申请报名').click();
    await visible(signup.getByText('已提交 1 项报名'));
    await button(owner,'按答卷筛选').click();
    const previous = await openOptions(owner,'筛选问卷版本');
    await previous.list.getByRole('option',{name:/历史问卷/}).click();
    await pickOption(owner,'筛选答案','有经验');
    await count(2,1);
    await owner.getByRole('row').filter({hasText:'签到岗'}).getByRole('button',{name:/查看/}).click();
    await answerValues(owner, ['初次参加','记录','这次可在服务台值班']);
    const history = answerDetail(owner).locator('details').filter({hasText:'历史答卷'});
    await history.locator('summary').click();
    assert.deepEqual(await history.locator('dd').allTextContents(), firstAnswers);
  });
});

test('审核队列和详情在焦点复核时保持原位，切换记录和失权清除旧详情', async t => {
  await withPages(t, async ({teacher, admin, db}) => {
    const pending = await db.activityReview.findFirstOrThrow({where:{status:'pending'}});
    const approved = await db.activityReview.findFirstOrThrow({where:{status:'approved'}});
    await teacher.goto(admin + '/reviews/' + pending.id);
    const pane = teacher.locator('.review-detail');
    const row = teacher.locator('.record-list-pane .entry-list a').first();
    await visible(pane);
    await visible(row);
    const note = teacher.getByLabel('审核意见（驳回必填）');
    await note.fill('已核对服务安排，稍后提交');
    const queue = await holdResponse(teacher, url => url.pathname === '/api/v1/admin/activity-reviews');
    const same = await holdResponse(teacher, url => url.pathname.endsWith('/' + pending.id));
    try {
      await teacher.evaluate(() => window.dispatchEvent(new Event('focus')));
      await Promise.all([same.received, queue.received]);
      assert.ok(await pane.isVisible());
      assert.ok(await row.isVisible());
      assert.equal(await note.inputValue(), '已核对服务安排，稍后提交');
      assert.ok(await button(teacher, '批准发布').isDisabled());
    } finally {
      await Promise.all([queue.release(), same.release()]);
    }
    await teacher.getByRole('button',{name:'批准发布',disabled:false}).waitFor();
    const denied = await holdResponse(teacher, url => url.pathname.endsWith('/' + approved.id), {status:403});
    try {
      await teacher.evaluate(id => {
        history.pushState(history.state, '', '/reviews/' + id);
        dispatchEvent(new PopStateEvent('popstate', {state:history.state}));
      }, approved.id);
      await denied.received;
      assert.equal(await pane.count(),0);
      assert.equal(await button(teacher,'批准发布').count(),0);
    } finally { await denied.release(); }
    await visible(teacher.getByRole('alert').filter({hasText:'读取最新数据失败'}));
    assert.equal(await pane.count(),0);
  });
});
