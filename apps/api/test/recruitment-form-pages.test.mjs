import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { button, fits, link, pickOption, visible, withPages } from './page-environment.mjs';

test('手机共答问卷、按项目报名，负责人实时筛选与逐项办理', async t => {
  await withPages(t, async ({ first, db, owner, student, web }) => {
    const base = await db.activityRevision.findFirstOrThrow({ where: { activity_id: first.id, revision: first.published_revision } });
    const ownerMember = await db.activityMember.findFirstOrThrow({ where: {activity_id:first.id, member_role:'owner'} });
    const items = ['讲解岗', '签到岗', '布展岗'].map(role => ({ id: randomUUID(), role,
      starts_at:base.content.schedule.starts_at, ends_at:base.content.schedule.ends_at, capacity:1, waitlist_capacity:1 }));
    const option = label => ({ id:randomUUID(), label });
    const questions = [
      { id:randomUUID(),type:'single',title:'是否有讲解经验',required:true,options:[option('有经验'),option('初次参加')] },
      { id:randomUUID(),type:'multiple',title:'熟悉的任务',required:true,options:[option('接待'),option('记录')] },
      { id:randomUUID(),type:'text',title:'备注',required:true },
    ];
    const title = '天文馆分岗问卷体验';
    const activity = await db.activity.create({ data:{
      activity_code:'UI-SURVEY',status:'published',working_revision:1,published_revision:1,
      members:{create:{account_id:ownerMember.account_id,member_role:'owner'}},
      revisions:{create:{revision:1,revision_state:'approved',created_by:ownerMember.account_id,approved_at:new Date(),
        content:{...base.content,title,registration_mode:'batch',registration_items:items,allow_multiple_roles:true,
          allow_multiple_slots:false,questions,capacity:3,waitlist_capacity:3,precautions:'请携带学生证',related_notes:'提前十分钟集合'}}},
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
  });
});
