import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationItemLabel } from '@hongyan/contracts/activity';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';
import { canRecruit } from '../dist/registrations/registration.js';
import { NoticeWorker } from '../dist/notices/notice.worker.js';
import { browser } from './api-client.mjs';
import { prepareTestDatabase } from './prepare-test-database.mjs';

test('报名项按北京时间合并同日日期，并区分跨日和全天', () => {
  const role = '读者服务岗';
  const label = (starts_at, ends_at) => registrationItemLabel({ role, starts_at, ends_at });
  assert.equal(registrationItemLabel({ role }), role);
  assert.equal(label('2026-12-04T23:00:00Z', '2026-12-05T02:00:00Z'), role + ' · 2026-12-05 07:00–10:00');
  assert.equal(label('2026-12-05T15:00:00Z', '2026-12-05T16:00:00Z'), role + ' · 2026-12-05 23:00 至 2026-12-06 00:00');
  assert.equal(label('2026-12-04T16:00:00Z', '2026-12-05T16:00:00Z'), role + ' · 2026-12-05 全天');
  assert.equal(label('2026-12-04T16:00:30Z', '2026-12-05T16:00:30Z'), role + ' · 2026-12-05 00:00 至 2026-12-06 00:00');
});

test('按日期与精确时段的退出、录取和恢复边界', () => {
  const dated = {
    schedule: {
      schedule_type: 'date_range',
      duration_start_date: '2026-11-24',
      duration_end_date: '2026-11-25',
    },
  };
  for (const [exit, boundary] of [
    [true, '2026-11-24'],
    [false, '2026-11-26'],
  ]) {
    const cutoff = Date.parse(boundary + 'T00:00:00+08:00');
    assert.ok(canRecruit(dated, exit, new Date(cutoff - 1)));
    assert.equal(canRecruit(dated, exit, new Date(cutoff)), false);
  }
  const start = '2026-11-25T13:00:00+08:00';
  const exact = {
    schedule: {
      schedule_type: 'custom',
      slots: [{ starts_at: start, ends_at: '2026-11-25T17:00:00+08:00' }],
    },
  };
  for (const exit of [false, true]) {
    assert.ok(canRecruit(exact, exit, new Date(Date.parse(start) - 1)));
    assert.equal(canRecruit(exact, exit, new Date(start)), false);
  }
});

test('招募写入、最后一席竞争及通知回执使用独立库', async (t) => {
  process.env.NOTICE_WORKER = 'off';
  let app;
  t.after(() => app?.close());
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: randomUUID() });
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    worker = app.get(NoticeWorker);
  const base = (await app.getUrl()) + '/api/v1';
  const users = Array.from({ length: 4 }, () => browser(base));
  const [alice, owner, bob, helper] = users;
  await Promise.all(
    users.map((u, i) =>
      u.signIn(String(i + 1).padStart(10, '0'), String(i + 1).padStart(6, '0'), randomUUID()),
    ),
  );
  const activity = await db.activity.findUniqueOrThrow({
    where: { activity_code: 'P2026-0001' },
    include: { revisions: true },
  });
  const id = activity.id,
    content = { ...activity.revisions[0].content, waitlist_capacity: 105 };
  const revision = { activity_id_revision: { activity_id: id, revision: 1 } };
  await db.activityRevision.update({ where: revision, data: {content} });
  const registration = (r) => db.registration.findUniqueOrThrow({ where: { id: r.id } });
  const accepted = () => db.registration.count({ where: { activity_id: id, status: 'accepted' } });
  const success = (r, status = 200) => {
    assert.equal(r.status, status, JSON.stringify(r));
    return r.data;
  };
  const write = (u, path, body, key) => u.write('POST', path, body, key);
  const apply = (u) => write(u, '/activities/' + id + '/registrations', {});
  const items = (rows) => rows.map((r) => ({ registration_id: r.id, expected_version: r.version }));
  const bulk = (rows, decision, who = owner, key) =>
    write(
      who,
      '/organizer/activities/' + id + '/registration-decisions',
      { items: items(rows), decision },
      key,
    );
  const request = (u, kind, r) =>
    write(u, '/me/' + kind + '-requests', {
      registration_id: r.id,
      expected_registration_version: r.version,
      reason: '时间调整',
    });
  const finish = (u, kind, q, decision, key) =>
    write(
      u,
      '/organizer/' + kind + '-requests/' + q.id + '/decision',
      { expected_version: q.version, decision, reason: '已核实' },
      key,
    );
  const withdraw = (u, kind, q) =>
    write(u, '/me/' + kind + '-requests/' + q.id + '/withdraw', { expected_version: q.version });
  const counts = () =>
    Promise.all([
      db.registrationHistory.count(),
      db.notificationEvent.count(),
    ]);
  const mineSchedule = async () => {
    const { starts_at, ends_at } = content.schedule;
    const params = new URLSearchParams({ scope: 'mine', from: starts_at, to: ends_at });
    return success(await alice.request('/timeline?' + params)).items.some((a) => a.activity_id === id);
  };
  let a = success(await apply(alice), 201).items[0],
    b = success(await apply(bob), 201).items[0];
  const originalId = a.id;
  const helperStudent = await db.student.findUniqueOrThrow({ where: { student_no: '0000000004' } });
  const source = await db.notice.create({
    data: {
      activity_id: id,
      title: '集合',
      body: '南门',
      notice_kind: 'gathering',
      information_version: 3,
      receipts: { create: { student_id: helperStudent.id } },
    },
  });
  await t.test('本人撤回、窗口内原 ID 重提及关闭窗口后批量办理', async () => {
    const url = '/me/registrations/' + a.id + '/withdraw';
    assert.equal((await write(bob, url, { expected_version: a.version })).status, 404);
    assert.equal(success(await write(alice, url, { expected_version: a.version })).status, 'withdrawn');
    a = success(await apply(alice), 201).items[0];
    assert.equal(a.id, originalId);
    await db.activityRevision.update({
      where: revision,
      data: {
        content: {
          ...content,
          capacity: 2,
          registration_closes_at: new Date(Date.now() - 1000).toISOString(),
        },
      },
    });
    assert.equal((await apply(alice)).code, 'registration_closed');
    const before = await counts();
    assert.equal((await bulk([], 'accepted')).status, 422);
    assert.equal((await bulk([a, a], 'accepted')).status, 422);
    assert.equal((await bulk(Array(101).fill(a), 'accepted')).status, 422);
    const stale = await bulk([a, { ...b, version: b.version + 1 }], 'accepted');
    assert.equal(stale.details[0].resource_id, b.id);
    assert.equal((await bulk([a, b], 'accepted')).code, 'capacity_conflict');
    assert.deepEqual(await counts(), before);
    const key = randomUUID();
    const decision = await bulk([a, b], 'rejected', owner, key);
    assert.equal(success(decision).affected_count, 2);
    assert.deepEqual(await bulk([a, b], 'rejected', owner, key), decision);
    await worker.drain();
    [a, b] = success(await bulk(await Promise.all([registration(a), registration(b)]), 'waitlisted')).items;
    // 候补进入退避时先完成补录，迟到重试必须以报名版本判定。
    const delayed = await db.notificationEvent.findUniqueOrThrow({
      where: { event_key: `registration_decision:${a.id}:${a.version}` },
    });
    await db.notificationEvent.update({ where: { id: delayed.id }, data: { next_retry_at: new Date(Date.now() + 60_000) } });
    a = success(await bulk([a], 'accepted')).items[0];
    assert.equal((await bulk([a], 'rejected')).code, 'invalid_state');
    await worker.drain();
    await worker.drain(new Date(Date.now() + 61_000));
    assert.equal((await db.notificationEvent.findUniqueOrThrow({ where: { id: delayed.id } })).status, 'superseded');
    assert.equal(await db.notice.count({ where: { source_event_id: delayed.id } }), 0);
    for (const [u, expected] of [
      [alice, '已被录取'],
      [bob, '进入候补'],
    ]) {
      const rows = success(await u.request('/me/notices?notice_kind=result')).items;
      assert.ok(rows.some((n) => n.body.includes(expected)));
      assert.ok(rows.some((n) => n.body.includes('未被录取') && !n.is_current));
      assert.equal(rows.filter(n => n.is_current).length, 1);
    }
  });
  await t.test('退出和恢复均可撤回、驳回，批准退出仅释放一次', async () => {
    let q = success(await request(alice, 'exit', a), 201);
    assert.equal(await accepted(), 2);
    assert.equal(await mineSchedule(), true);
    assert.equal((await request(alice, 'exit', a)).status, 409);
    assert.equal((await withdraw(bob, 'exit', q)).status, 404);
    success(await withdraw(alice, 'exit', q));
    assert.equal((await finish(owner, 'exit', q, 'approved')).status, 409);
    q = success(await request(alice, 'exit', a), 201);
    success(await finish(owner, 'exit', q, 'rejected'));
    assert.equal(await accepted(), 2);
    q = success(await request(alice, 'exit', a), 201);
    const key = randomUUID();
    const decision = await finish(owner, 'exit', q, 'approved', key);
    success(decision);
    assert.deepEqual(await finish(owner, 'exit', q, 'approved', key), decision);
    a = await registration(a);
    assert.equal(a.status, 'exited');
    assert.equal(await accepted(), 1);
    assert.equal(await mineSchedule(), false);
    q = success(await request(alice, 'restoration', a), 201);
    success(await withdraw(alice, 'restoration', q));
    q = success(await request(alice, 'restoration', a), 201);
    success(await finish(helper, 'restoration', q, 'rejected'));
    assert.equal((await registration(a)).status, 'exited');
  });
  await t.test('两负责人竞争最后一席，恢复仅跟进新的同版本回执', async () => {
    const q = success(await request(alice, 'restoration', a), 201);
    const [promotion, restoration] = await Promise.all([
      bulk([b], 'accepted'),
      finish(helper, 'restoration', q, 'approved'),
    ]);
    assert.deepEqual([promotion.status, restoration.status].sort(), [200, 409]);
    assert.equal(await accepted(), 2);
    if (promotion.status === 200) {
      assert.equal(restoration.code, 'capacity_conflict');
      assert.equal((await db.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'pending');
      const exit = success(await request(bob, 'exit', await registration(b)), 201);
      success(await finish(owner, 'exit', exit, 'approved'));
      success(await finish(helper, 'restoration', q, 'approved'));
    } else assert.equal(promotion.code, 'capacity_conflict');
    a = await registration(a);
    assert.equal(a.id, originalId);
    assert.equal(a.status, 'accepted');
    assert.equal(await mineSchedule(), true);
    await worker.drain();
    const inbox = (suffix) => alice.request('/me/notices?notice_kind=gathering' + suffix);
    const all = success(await inbox('')).items;
    assert.equal(all.length, 2);
    const current = success(await inbox('&unacknowledged_only=true')).items;
    assert.equal(current.length, 1);
    assert.ok(all.every((n) => n.source_notice_id === source.id && n.information_version === 3));
    assert.equal(await db.noticeReceipt.count({ where: { notice_id: source.id } }), 1);
    const event = await db.notice.findUniqueOrThrow({ where: { id: current[0].id } });
    await db.notificationEvent.update({ where: { id: event.source_event_id }, data: { status: 'pending' } });
    await worker.drain();
    assert.equal(success(await inbox('')).total, 2);
    assert.ok(
      success(await alice.request('/me/notices?notice_kind=result&page_size=100')).items.some((n) =>
        n.body.includes('恢复申请已批准'),
      ),
    );
  });
  await t.test('百人批量处理在停用一人时整批回滚，启用后只生效一次', async () => {
    const accounts = Array.from({ length: 100 }, (_, index) => ({
      id: randomUUID(),
      username: String(8100000000 + index),
      display_name: '独立库学生' + index,
      password_hash: 'fixture',
    }));
    await db.account.createMany({ data: accounts });
    const students = accounts.map((r) => ({ id: randomUUID(), student_no: r.username, account_id: r.id }));
    await db.student.createMany({ data: students });
    const records = students.map((r) => ({
      id: randomUUID(),
      version: 1,
      status: 'submitted',
      student_id: r.id,
      activity_id: id,
    }));
    await db.registration.createMany({ data: records });
    const submitted = await db.registration.findMany({ where: { id: { in: records.map(row => row.id) } } });
    await db.registrationHistory.createMany({ data: submitted.map(row => ({
      registration_id: row.id, version: row.version, status: row.status,
      submitted_at: row.submitted_at, changed_at: row.submitted_at,
    })) });
    const last = accounts.at(-1);
    await db.account.update({ where: { id: last.id }, data: { active: false } });
    const before = await counts();
    const failure = await bulk(records, 'waitlisted');
    assert.equal(failure.status, 409);
    assert.equal(failure.details[0].resource_id, records.at(-1).id);
    assert.deepEqual(await counts(), before);
    await db.account.update({ where: { id: last.id }, data: { active: true } });
    const key = randomUUID();
    const result = await bulk(records, 'waitlisted', owner, key);
    assert.equal(success(result).affected_count, 100);
    assert.deepEqual(await bulk(records, 'waitlisted', owner, key), result);
    assert.deepEqual(
      await counts(),
      before.map(n => n + 100),
    );
    await worker.drain();
    await worker.drain();
  });
  await t.test('按日活动开始后可审批既有退出，当天可恢复，精确活动最后时段开始后禁止恢复', async () => {
    const q = success(await request(alice, 'exit', a), 201);
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const dateSchedule = {
      schedule_type: 'date_range',
      duration_start_date: today,
      duration_end_date: today,
    };
    const setSchedule = (schedule) =>
      db.activityRevision.update({ where: revision, data: { content: { ...content, schedule } } });
    await setSchedule(dateSchedule);
    success(await finish(owner, 'exit', q, 'approved'));
    a = await registration(a);
    const restoration = success(await request(alice, 'restoration', a), 201);
    await setSchedule({
      schedule_type: 'continuous',
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal((await finish(owner, 'restoration', restoration, 'approved')).code, 'invalid_state');
    await setSchedule(dateSchedule);
    success(await finish(owner, 'restoration', restoration, 'approved'));
    a = await registration(a);
    assert.equal((await request(alice, 'exit', a)).code, 'invalid_state');
    await setSchedule(content.schedule);
  });
  await t.test('活动终态在同一事务取消申请，成员被移出后旧窗口提交失败', async () => {
    const submitted = success(await apply(owner), 201).items[0];
    const ownRegistration = async () => success(await owner.request('/me/registrations?id=' + submitted.id)).items[0];
    const supplement = await db.notificationEvent.findUniqueOrThrow({
      where: { event_key: `gathering:${a.id}:${a.version}:${source.id}` },
    });
    assert.equal(supplement.status, 'pending');
    const q = success(await request(alice, 'exit', a), 201);
    // 给另一名已退出学生预置待恢复申请，与退出申请一起验证同事务收尾。
    await db.registration.update({ where: { id: b.id }, data: { status: 'exited' } });
    const restore = success(await request(bob, 'restoration', await registration(b)), 201);
    success(await helper.request('/organizer/activities/' + id + '/exit-requests'));
    await db.activityMember.deleteMany({ where: { activity_id: id, account_id: helperStudent.account_id } });
    assert.equal((await finish(helper, 'exit', q, 'approved')).status, 404);
    for (const status of ['cancelled', 'completed']) {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.activity.update({ where: { id }, data: { status } });
          assert.equal((await tx.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'cancelled');
          assert.equal(
            (await tx.exitRequest.findUniqueOrThrow({ where: { id: restore.id } })).status,
            'cancelled',
          );
          throw new Error('rollback');
        }),
        /rollback/,
      );
      assert.equal((await db.exitRequest.findUniqueOrThrow({ where: { id: q.id } })).status, 'pending');
    }
    await db.activity.update({ where: { id }, data: { status: 'completed' } });
    assert.equal((await finish(owner, 'exit', q, 'approved')).status, 409);
    await worker.drain();
    assert.equal(await db.notice.count({ where: { source_event_id: supplement.id } }), 0);
    assert.equal((await db.notificationEvent.findUniqueOrThrow({ where: { id: supplement.id } })).status, 'superseded');
    assert.equal((await ownRegistration()).can_withdraw, false);
    assert.equal((await write(owner, '/me/registrations/' + submitted.id + '/withdraw', { expected_version: submitted.version })).code, 'invalid_state');
    const results = success(await alice.request('/me/notices?notice_kind=result&page_size=100'));
    assert.ok(results.items.some((n) => n.body.includes('因活动取消或结束已取消')));
  });
  await t.test('活动取消与恢复批准争用同一活动锁，迟到集合补发作废', async () => {
    const createdBy = activity.revisions[0].created_by;
    const next = await db.activity.create({ data: {
      activity_code: 'RECRUIT-CANCEL', status: 'published', working_revision: 1, published_revision: 1,
      members: { create: { account_id: createdBy, member_role: 'owner' } },
      revisions: { create: { revision: 1, revision_state: 'approved', content, created_by: createdBy } },
      notices: { create: { title: '集合', body: '北门', notice_kind: 'gathering' } },
    } });
    const form = success(await write(alice, '/activities/' + next.id + '/registrations', {}), 201).items[0];
    success(await write(owner, '/organizer/registrations/' + form.id + '/decision', { decision: 'accepted', expected_version: form.version }));
    const exited = await db.registration.create({ data: { activity_id: next.id, student_id: b.student_id, status: 'exited' } });
    const pending = success(await request(bob, 'restoration', exited), 201);
    const [, approval] = await Promise.all([
      db.activity.update({ where: { id: next.id }, data: { status: 'cancelled' } }),
      finish(owner, 'restoration', pending, 'approved'),
    ]);
    assert.ok([200, 409].includes(approval.status));
    const won = approval.status === 200;
    assert.equal((await registration(exited)).status, won ? 'accepted' : 'exited');
    assert.equal((await db.exitRequest.findUniqueOrThrow({ where: { id: pending.id } })).status, won ? 'approved' : 'cancelled');
    await worker.drain();
    const events = await db.notificationEvent.findMany({ where: { activity_id: next.id, event_type: 'gathering_supplement' } });
    assert.equal(events.length, won ? 2 : 1);
    assert.ok(events.every(e => e.status === 'superseded'));
    assert.equal(success(await alice.request('/me/notices?notice_kind=gathering&activity_id=' + next.id)).total, 0);
    const results = success(await bob.request('/me/notices?notice_kind=result&activity_id=' + next.id));
    assert.equal(results.total, 1);
    assert.match(results.items[0].body, won ? /已批准/ : /已取消/);
  });

  await t.test('分项报名共用答卷，旧版本可筛选，逐项退出，名单实时通知', async () => {
    const role = randomUUID(), second = randomUUID(), later = randomUUID(), general = randomUUID();
    const single = randomUUID(), multiple = randomUUID(), fill = randomUUID();
    const opt = { id: randomUUID(), label: '培训已完成' }, other = { id: randomUUID(), label: '需要培训' };
    const questions = [
      {id:single,type:'single',title:'培训',required:true,options:[opt,other]},
      {id:multiple,type:'multiple',title:'技能',required:true,options:[opt,other]},
      {id:fill,type:'text',title:'说明',required:true},
    ];
    const answers = [
      {question_id:single,option_ids:[opt.id]}, {question_id:multiple,option_ids:[opt.id,other.id]},
      {question_id:fill,text:'可协助讲解'},
    ];
    const {starts_at,ends_at} = content.schedule;
    const items = [
      {id:general,role:'引导',capacity:1,waitlist_capacity:0},
      {id:role,role:'引导',starts_at,ends_at,capacity:1,waitlist_capacity:1},
      {id:second,role:'讲解',starts_at,ends_at,capacity:1,waitlist_capacity:0},
      {id:later,role:'引导',starts_at:ends_at,ends_at:new Date(Date.parse(ends_at)+3600000).toISOString(),capacity:1,waitlist_capacity:0},
    ];
    const config = {...content,capacity:4,waitlist_capacity:1,registration_mode:'batch',questions,registration_items:items};
    const created_by = activity.revisions[0].created_by;
    const batch = await db.activity.create({data:{
      activity_code:'RECRUIT-SURVEY',status:'published',working_revision:1,published_revision:1,
      members:{create:{account_id:created_by,member_role:'owner'}},
      revisions:{create:{revision:1,revision_state:'approved',content:config,created_by}},
    }});
    const path = '/activities/' + batch.id;
    const detail = async u => success(await u.request(path));
    const version = (await detail(alice)).questionnaire_version;
    let revision = 1;
    const submit = (u, item_ids, extras, key) => write(u,path+'/registrations',{published_revision:revision,questionnaire_version:version,item_ids,...extras},key);
    const setConfig = async (n, update) => {
      await db.activityRevision.create({data:{activity_id:batch.id,revision:n,revision_state:'approved',content:update,created_by}});
      await db.activity.update({where:{id:batch.id},data:{published_revision:n,working_revision:n}});
      revision = n;
    };
    assert.equal((await submit(alice,[role],{})).status,422);
    assert.equal((await submit(alice,[role,second],{answers})).status,422);
    assert.equal((await submit(alice,[role,general],{answers})).status,422);
    assert.equal((await submit(alice,[role,later],{answers})).status,422);
    assert.equal((await submit(alice,[role],{questionnaire_version:'obsolete',answers})).status,409);
    config.allow_multiple_roles = true; config.allow_multiple_slots = true;
    // Reusing an unclaimed item ID for different work must invalidate an open student form.
    config.registration_items[0] = {...config.registration_items[0], role:'服务台'};
    await setConfig(2,config);
    assert.equal((await submit(alice,[general],{published_revision:1,answers})).code, 'version_conflict');
    assert.equal((await write(alice,path+'/registrations',{item_ids:[general],questionnaire_version:version,answers})).status,422);
    assert.equal(await db.registration.count({where:{activity_id:batch.id}}),0);

    const controller = new AbortController();
    try {
      const reader = (await owner.raw('/organizer'+path+'/registration-events?scope=managed',{signal:controller.signal})).body.getReader();
      let chunk = '';
      const until = async regex => {
        while (!regex.test(chunk)) {
          const next = await reader.read();
          assert.equal(next.done,false);
          chunk += new TextDecoder().decode(next.value);
        }
      };
      const timeout = setTimeout(()=>controller.abort(),5000);
      try {
        await until(/connected/);
        const key = randomUUID(), response = await submit(alice,[role,second],{answers},key);
        const result = success(response,201);
        assert.deepEqual(result.items.map(r=>r.item_id),[role,second]);
        assert.deepEqual(result.items[0].answers,result.items[1].answers);
        assert.deepEqual(await submit(alice,[role,second],{answers},key),response);
        await until(/changed/);
      } finally {clearTimeout(timeout);}
    } finally {controller.abort();}
    const supplemental = success(await submit(alice,[later],{}),201).items[0];
    assert.equal(supplemental.answers.find(a=>a.question_id===fill).text,'可协助讲解');
    assert.equal(await db.questionnaireResponse.count({where:{activity_id:batch.id}}),1);
    const filters = encodeURIComponent(JSON.stringify([{question_id:single,option_id:opt.id},{question_id:fill,answer_text:'协助'}]));
    const roster = async query => success(await owner.request('/organizer'+path+'/registrations?scope=managed&'+query));
    const all = await roster('answer_filters='+filters);
    assert.equal(all.total,3);
    assert.equal(all.unique_student_count,1);
    assert.equal((await roster('answer_filters='+filters+'&item_id='+second)).total,1);
    const revised = questions.map(q=>q.id===single?{...q,title:'新培训题',options:[{...opt,label:'完成新培训'},other]}:q);
    await setConfig(3,{...config,questions:revised});
    const newVersion = (await detail(bob)).questionnaire_version;
    assert.notEqual(newVersion,version);
    assert.equal((await submit(bob,[role],{answers})).status,409);
    const bRow = success(await submit(bob,[role],{answers,questionnaire_version:newVersion}),201).items[0];
    assert.equal(bRow.answers[0].labels[0],'完成新培训');
    const changed = await roster('item_id='+role+'&answer_filters='+filters);
    assert.equal(changed.items.find(r=>r.id!==bRow.id).answers[0].title,'培训');
    assert.equal(changed.question_versions.length,2);
    assert.deepEqual(changed.question_versions.map(q=>[q.questionnaire_version,q.is_current]),[[newVersion,true],[version,false]]);
    const byVersion = v => encodeURIComponent(JSON.stringify([{questionnaire_version:v,question_id:single,option_id:opt.id}]));
    assert.deepEqual((await roster('item_id='+role+'&answer_filters='+byVersion(newVersion))).items.map(r=>r.id),[bRow.id]);
    assert.equal((await roster('item_id='+role+'&answer_filters='+byVersion(version))).items[0].answers[0].labels[0],'培训已完成');
    const reapplyId = supplemental.id;
    success(await write(alice,'/me/registrations/'+reapplyId+'/withdraw',{expected_version:supplemental.version}));
    const updatedAnswers = [{question_id:single,option_ids:[other.id]},answers[1],{question_id:fill,text:'可协助摄影'}];
    const updated = success(await submit(alice,[later],{answers:updatedAnswers,questionnaire_version:newVersion}),201).items[0];
    assert.equal(updated.id,reapplyId);
    assert.equal(updated.answer_history[0].questionnaire_version,version);
    assert.equal(updated.answer_history[0].answers[0].labels[0],'培训已完成');
    assert.equal((await roster('answer_filters='+filters+'&item_id='+later)).total,1);
    const incompatible = encodeURIComponent(JSON.stringify([{question_id:single,option_id:other.id},{question_id:fill,answer_text:'讲解'}]));
    assert.equal((await roster('answer_filters='+incompatible+'&item_id='+later)).total,0);
    const aliceRows = (await detail(alice)).my_registrations;
    const picked = aliceRows.filter(r=>[role,second].includes(r.item_id));
    const acceptedRows = success(await write(owner,'/organizer'+path+'/registration-decisions',{
      decision:'accepted',items:picked.map(r=>({registration_id:r.id,expected_version:r.version})),
    })).items;
    const quit = success(await request(alice,'exit',acceptedRows[0]),201);
    assert.equal(success(await alice.request('/me/exit-requests?registration_id='+acceptedRows[1].id)).total,0);
    success(await finish(owner,'exit',quit,'approved'));
    const afterExit = await detail(alice);
    assert.equal(afterExit.my_registrations.find(r=>r.id===acceptedRows[1].id).status,'accepted');
    assert.ok(!Object.hasOwn(afterExit, 'my_registration_status'));
    assert.ok(afterExit.group_join_instructions);
  });

  await t.test('9个录取加6个候补，两个学生竞争第15份有效报名，满项使多项提交全部回滚', async () => {
    const full = randomUUID(), free = randomUUID(), created_by = activity.revisions[0].created_by;
    const next = await db.activity.create({data:{
      activity_code:'RECRUIT-LAST-APPLICATION',status:'published',working_revision:1,published_revision:1,
      members:{create:{account_id:created_by,member_role:'owner'}},
      revisions:{create:{revision:1,revision_state:'approved',created_by,content:{
        ...content,capacity:10,registration_mode:'batch',allow_multiple_roles:true,registration_items:[
          {id:full,role:'讲解',capacity:9,waitlist_capacity:6},{id:free,role:'引导',capacity:1,waitlist_capacity:0},
        ],
      }}},
    }});
    const prepared = Array.from({length:14},(_,i)=>({id:randomUUID(),username:String(8200000000+i),display_name:'名额测试'+i}));
    await db.account.createMany({data:prepared});
    const fixtureStudents = prepared.map(a=>({id:randomUUID(),student_no:a.username,account_id:a.id}));
    await db.student.createMany({data:fixtureStudents});
    await db.registration.createMany({data:fixtureStudents.map(r=>({student_id:r.id,activity_id:next.id,item_id:full,item_label:'讲解',status:'submitted'}))});
    const post = (u, ids) => write(u,'/activities/'+next.id+'/registrations',{published_revision:1,item_ids:ids});
    const results = await Promise.all([post(alice,[full]),post(bob,[full])]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    const lose = results[0].status===409 ? alice : bob;
    assert.equal((await post(lose,[free,full])).code,'capacity_conflict');
    assert.equal(await db.registration.count({where:{activity_id:next.id,item_id:free}}),0);
    const rows = await db.registration.findMany({where:{activity_id:next.id,item_id:full}});
    assert.equal(rows.length,15);
    assert.ok(rows.every(r=>r.status==='submitted'));
    const decide = (rows, decision) => write(owner,'/organizer/activities/'+next.id+'/registration-decisions',{items:items(rows),decision});
    success(await decide(rows.slice(0,9),'accepted'));
    assert.equal((await decide(rows.slice(9,10),'accepted')).code,'capacity_conflict');
    success(await decide(rows.slice(9),'waitlisted'));
    const noWait = success(await post(lose,[free]),201).items[0];
    assert.equal((await decide([noWait],'waitlisted')).code,'capacity_conflict');
  });

  await t.test('按统一窗口报名和办理已过及进行中场次，未来场次可独立申请退出', async () => {
    const created_by = activity.revisions[0].created_by;
    const now = Date.now(), offset = hours => new Date(now + hours * 3600000).toISOString();
    const current = randomUUID(), future = randomUUID(), ended = randomUUID();
    const batch = await db.activity.create({data:{
      activity_code:'RECRUIT-IN-PROGRESS',status:'published',working_revision:1,published_revision:1,
      members:{create:{account_id:created_by,member_role:'owner'}},
      revisions:{create:{revision:1,revision_state:'approved',created_by,content:{...content,capacity:3,
        schedule:{schedule_type:'continuous',starts_at:offset(-48),ends_at:offset(48)},
        registration_opens_at:offset(-72),registration_closes_at:offset(24),registration_mode:'batch',allow_multiple_slots:true,
        registration_items:[
          {id:current,starts_at:offset(-1),ends_at:offset(1),capacity:1,waitlist_capacity:0},
          {id:future,starts_at:offset(24),ends_at:offset(26),capacity:1,waitlist_capacity:0},
          {id:ended,starts_at:offset(-12),ends_at:offset(-10),capacity:1,waitlist_capacity:0},
        ],
      }}},
    }});
    const rows = success(await write(alice,'/activities/'+batch.id+'/registrations',{published_revision:1,item_ids:[current,future,ended]}),201).items;
    const decide = rows => write(owner,'/organizer/activities/'+batch.id+'/registration-decisions',{items:items(rows),decision:'accepted'});
    assert.equal(success(await decide([rows[2]])).items[0].status,'accepted');
    const accepted = success(await decide(rows.slice(0,2))).items;
    assert.equal((await request(alice,'exit',accepted[0])).code,'invalid_state');
    success(await request(alice,'exit',accepted[1]),201);
  });

});
