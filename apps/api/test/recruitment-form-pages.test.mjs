import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { button, fits, holdResponse, link, openOptions, pickOption, settleRender, visible, withPages } from './page-environment.mjs';

test('手机共答问卷、按项目报名，负责人实时筛选与逐项办理', async t => {
  await withPages(t, async ({ first, db, owner, student, helper, web }) => {
    const base = await db.activityRevision.findFirstOrThrow({ where: { activity_id: first.id, revision: first.published_revision } });
    const ownerMember = await db.activityMember.findFirstOrThrow({ where: {activity_id:first.id, member_role:'owner'} });
    const items = ['讲解岗', '签到岗', '布展岗', '咨询岗'].map(role => ({ id: randomUUID(), role,
      starts_at:base.content.schedule.starts_at, ends_at:base.content.schedule.ends_at, capacity:1, waitlist_capacity:1 }));
    const option = label => ({ id:randomUUID(), label });
    const questionTitle = '是否有讲解经验，能够面向不同年龄段的读者介绍天文展品、安排参观路线，并在团队到场前独立完成设备检查？';
    const questions = [
      { id:randomUUID(),type:'single',title:questionTitle,required:true,options:[option('有经验'),option('初次参加')] },
      { id:randomUUID(),type:'multiple',title:'熟悉的任务',required:true,options:[option('接待'),option('记录')] },
      { id:randomUUID(),type:'text',title:'备注',required:true },
    ];
    const title = '天文馆分岗问卷体验';
    const activity = await db.activity.create({ data:{
      activity_code:'UI-SURVEY',status:'published',working_revision:1,published_revision:1,
      members:{create:{account_id:ownerMember.account_id,member_role:'owner'}},
      revisions:{create:{revision:1,revision_state:'approved',created_by:ownerMember.account_id,approved_at:new Date(),
        content:{...base.content,title,registration_mode:'batch',registration_items:items,allow_multiple_roles:true,
          allow_multiple_slots:false,questions,capacity:4,waitlist_capacity:4,precautions:'请携带学生证',related_notes:'提前十分钟集合'}}},
    }});
    await owner.setViewportSize({width:1440,height:900});
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
    await student.goto(web);
    await link(student,title).click();
    await visible(student.getByText('请携带学生证'));
    await visible(student.getByText('提前十分钟集合'));
    const signup = student.locator('form.signup');
    await signup.getByRole('checkbox',{name:/讲解岗/}).check();
    await signup.getByRole('checkbox',{name:/签到岗/}).check();
    await button(student,'申请报名').click();
    await visible(student.getByRole('alert').filter({hasText:'是否有讲解经验'}));
    await signup.getByRole('radio',{name:'有经验'}).check();
    await signup.getByRole('checkbox',{name:'接待',exact:true}).check();
    await signup.getByRole('checkbox',{name:'记录',exact:true}).check();
    await signup.getByRole('textbox',{name:'备注'}).fill('可使用英文接待');
    await fits(student);
    await button(student,'申请报名').click();
    await visible(student.getByText('已提交 2 项报名',{exact:true}));
    await visible(owner.getByText('共 2 人次、1 人',{exact:false}));
    await signup.getByRole('checkbox',{name:/布展岗/}).check();
    await visible(student.getByText('已提交本版问卷，补报时共用这份答卷'));
    await button(student,'申请报名').click();
    await visible(owner.getByText('共 3 人次、1 人',{exact:false}));
    const studentCount = await db.questionnaireResponse.count({where:{activity_id:activity.id}});
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
    await visible(owner.getByText('接待、记录',{exact:true}));
    await button(owner,'录取此人').click();
    await visible(owner.getByText('已录取体验学生',{exact:true}));
    await link(student.locator('.activity-detail'),'我的报名').click();
    const registration = student.locator('.summary-list li').filter({hasText:'讲解岗'});
    await visible(registration.getByText('已录取',{exact:true}));
    await link(registration,'办理与进度').click();
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
    const revision = await db.activityRevision.findFirstOrThrow({where:{activity_id:activity.id,revision:1}});
    const revised = structuredClone(questions);
    revised[0].options[0].label = '仅限周日';
    const revisedItems = items.map(item => item.role === '咨询岗'
      ? {...item, starts_at:new Date(Date.parse(item.starts_at) + 30 * 60000).toISOString()}
      : item);
    await db.$transaction([
      db.activityRevision.create({data:{activity_id:activity.id,revision:2,revision_state:'approved',created_by:ownerMember.account_id,
        approved_at:new Date(),content:{...revision.content,questions:revised,registration_items:revisedItems}}}),
      db.activity.update({where:{id:activity.id},data:{working_revision:2,published_revision:2,version:{increment:1}}}),
    ]);
    await button(helper,'申请报名').click();
    await visible(other.getByText('报名项目和问卷已更新，请重新选择变更的项目并复核答案'));
    assert.equal(await other.getByRole('checkbox', {name:/咨询岗/}).isChecked(), false);
    assert.equal(await other.getByRole('checkbox', {name:/讲解岗/}).isChecked(), true);
    assert.equal(await db.registration.count({where:{activity_id:activity.id,item_id:items[3].id}}),0);
    assert.equal(await other.getByRole('textbox',{name:'备注'}).inputValue(), '保留这段内容');
    assert.ok(await other.getByRole('checkbox',{name:'接待',exact:true}).isChecked());
    assert.ok(!await other.getByRole('radio',{name:'仅限周日'}).isChecked());
    await other.getByRole('radio',{name:'仅限周日'}).check();
    await button(helper,'申请报名').click();
    await visible(other.getByText('已提交 1 项报名'));
    await link(nav, '报名名单').click();
    await button(owner, '按答卷筛选').click();
    await pickOption(owner, '筛选答案', '仅限周日');
    await visible(owner.getByText('共 1 人次、1 人', {exact:false}));
    await visible(owner.getByRole('cell', {name:'0000000004', exact:true}));
    const versions = await openOptions(owner, '筛选问卷版本');
    await versions.list.getByRole('option', {name:/历史问卷/}).click();
    await pickOption(owner, '筛选答案', '有经验');
    await visible(owner.getByText('共 2 人次、1 人', {exact:false}));
    assert.equal(await owner.getByRole('cell', {name:'0000000004', exact:true}).count(), 0);
    assert.equal(await owner.getByRole('cell', {name:'0000000001', exact:true}).count(), 2);
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
