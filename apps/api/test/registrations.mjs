import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function registrationCases(t, { db, student, owner, other, teacher, dual, sample }) {
  const ownerId = (await owner.request('/me')).data.account_id;
  const me = (await student.request('/me')).data.student;
  const otherStudent = (await other.request('/me')).data.student;
  const dualId = (await dual.request('/me')).data.account_id;
  const now = Date.now();
  const time = (ms) => new Date(now + ms).toISOString();
  async function activity(fields = {}) {
    const content = { ...sample.revisions[0].content, capacity: 2, ...fields };
    return db.activity.create({
      data: {
        activity_code: randomUUID(),
        status: 'published',
        working_revision: 1,
        published_revision: 1,
        revisions: {
          create: {
            content,
            revision: 1,
            revision_state: 'approved',
            created_by: ownerId,
            approved_at: new Date(),
          },
        },
        members: { create: { account_id: ownerId, member_role: 'owner' } },
      },
    });
  }
  const post = (actor, id, body = {}, key) =>
    actor.write('POST', '/activities/' + id + '/registrations', body, key);
  const roster = (actor, id, query = '') =>
    actor.request('/organizer/activities/' + id + '/registrations' + query);
  const decision = (actor, row, key, body = {}, suffix = '') =>
    actor.write(
      'POST',
      '/organizer/registrations/' + row.id + '/decision' + suffix,
      { expected_version: row.version, decision: 'accepted', ...body },
      key,
    );
  const mine = (actor, row) => actor.request('/me/registrations?id=' + row.id);
  const detail = (actor, id) => actor.request('/activities/' + id);

  await t.test(
    '报名开放时可提交、截止时停止新申请，获批的最后时段开始即停止录取',
    async (clock) => {
      const a = await activity({
        registration_opens_at: time(0),
        registration_closes_at: time(1000),
        schedule: {
          schedule_type: 'custom',
          duration_start_date: time(0).slice(0, 10),
          duration_end_date: time(0).slice(0, 10),
          slots: [
            { starts_at: time(2000), ends_at: time(3000) },
            { starts_at: time(4000), ends_at: time(5000) },
          ],
        },
      });
      const draft = {
        ...sample.revisions[0].content,
        title: '未批准的名称',
        capacity: 0,
        registration_opens_at: time(9000),
        registration_closes_at: time(10000),
      };
      await db.activityRevision.create({
        data: {
          activity_id: a.id,
          revision: 2,
          revision_state: 'draft',
          content: draft,
          created_by: ownerId,
        },
      });
      await db.activity.update({ where: { id: a.id }, data: { working_revision: 2 } });
      clock.mock.timers.enable({ apis: ['Date'], now: now - 1 });
      assert.equal((await post(student, a.id)).code, 'registration_not_open');
      clock.mock.timers.setTime(now);
      const first = await post(student, a.id);
      assert.equal(first.status, 201);
      assert.equal(first.data.submitted_at, time(0));
      clock.mock.timers.setTime(now + 999);
      const second = await post(other, a.id);
      assert.equal(second.status, 201);
      clock.mock.timers.setTime(now + 1000);
      assert.equal((await post(owner, a.id)).code, 'registration_closed');
      assert.equal(
        (await mine(student, first.data)).data.items[0].activity_title,
        sample.revisions[0].content.title,
      );
      assert.equal((await roster(owner, a.id)).data.capacity, 2);
      clock.mock.timers.setTime(now + 3999);
      assert.equal((await decision(owner, first.data)).status, 200);
      clock.mock.timers.setTime(now + 4000);
      assert.equal((await decision(owner, second.data)).code, 'invalid_state');
      assert.equal(await db.registrationDecisionEvent.count({ where: { activity_id: a.id } }), 1);
    },
  );

  await t.test('截止前收到的报名即使等待活动锁跨过截止也可提交', async (clock) => {
    const a = await activity({
      registration_opens_at: time(0),
      registration_closes_at: time(1000),
    });
    clock.mock.timers.enable({ apis: ['Date'], now: now + 999 });
    const locked = Promise.withResolvers(),
      unlock = Promise.withResolvers();
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM activity WHERE id=${a.id}::uuid FOR UPDATE`;
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const pending = post(student, a.id);
    try {
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await db.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM activity WHERE id=%FOR SHARE%') AS waiting`;
        waiting = row.waiting;
        if (!waiting) await delay(5);
      }
      assert.ok(waiting);
      clock.mock.timers.setTime(now + 1000);
    } finally {
      unlock.resolve();
      await blocker;
    }
    const result = await pending;
    assert.equal(result.status, 201);
    assert.equal(result.data.submitted_at, time(999));
    assert.equal((await post(other, a.id)).code, 'registration_closed');
  });

  await t.test('报名身份、并发去重、原键回放和撤回重提的版本历史', async () => {
    const a = await activity();
    assert.equal((await post(student, a.id, { student_id: otherStudent.id })).status, 422);
    assert.equal((await post(teacher, a.id)).status, 403);
    const path = '/activities/' + a.id + '/registrations';
    assert.equal(
      (await student.request(path, { method: 'POST', key: randomUUID(), csrfToken: '', body: {} }))
        .status,
      403,
    );
    assert.equal((await student.request(path, { method: 'POST', body: {} })).status, 422);
    const key = randomUUID();
    const body = { statement: '本人申请' };
    const [first, ...retries] = await Promise.all(
      [key, key, randomUUID(), randomUUID()].map((k) => post(student, a.id, body, k)),
    );
    assert.equal(first.status, 201);
    for (const retry of retries) {
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.data, first.data);
    }
    assert.deepEqual(await post(student, a.id, body, key), first);
    assert.equal((await post(student, a.id, { statement: '改动' }, key)).code, 'conflict');
    const row = first.data;
    assert.equal((await mine(other, row)).data.total, 0);
    assert.equal(await db.registration.count({ where: { activity_id: a.id } }), 1);
    const withdrawal = new Date();
    await db.registration.update({
      where: { id: row.id },
      data: { status: 'withdrawn', version: 2 },
    });
    await db.registrationHistory.create({
      data: {
        registration_id: row.id,
        version: 2,
        status: 'withdrawn',
        submitted_at: new Date(row.submitted_at),
        changed_at: withdrawal,
        actor_id: me.account_id,
      },
    });
    const next = await post(student, a.id, { statement: '再次申请' });
    assert.equal(next.data.id, row.id);
    assert.equal(next.data.version, 3);
    const history = await db.registrationHistory.findMany({
      where: { registration_id: row.id },
      orderBy: { version: 'asc' },
    });
    assert.deepEqual(
      history.map((v) => v.status),
      ['submitted', 'withdrawn', 'submitted'],
    );
    assert.equal(history[0].statement, body.statement);
    assert.deepEqual(history[1].changed_at, withdrawal);
    assert.equal(history[2].statement, '再次申请');
    for (const status of ['waitlisted', 'accepted', 'rejected', 'exited']) {
      await db.registration.update({ where: { id: row.id }, data: { status } });
      const result = await post(student, a.id);
      if (['rejected', 'exited'].includes(status)) assert.equal(result.code, 'invalid_state');
      else assert.equal(result.data.status, status);
    }
  });

  await t.test('最后一席并发录取、名单计数、隐私与持久事件快照', async () => {
    const a = await activity({ capacity: 1 });
    const one = (await post(student, a.id)).data,
      two = (await post(other, a.id)).data;
    for (const row of [one, two]) {
      assert.equal((await decision(other, row)).status, 404);
      assert.equal((await decision(student, row)).status, 403);
    }
    assert.equal((await roster(other, a.id)).status, 404);
    assert.equal((await roster(dual, a.id)).status, 404);
    assert.equal((await roster(dual, a.id, '?scope=all')).status, 200);
    assert.equal((await roster(other, a.id, '?scope=all')).status, 403);
    assert.equal((await roster(teacher, a.id)).status, 200);
    assert.equal((await decision(dual, one, undefined, {}, '?scope=managed')).status, 404);
    assert.equal((await mine(student, two)).data.total, 0);
    assert.equal((await detail(student, a.id)).data.group_join_instructions, undefined);
    const withoutCsrf = await owner.request('/organizer/registrations/' + one.id + '/decision', {
      method: 'POST',
      csrfToken: '',
      key: randomUUID(),
      body: { expected_version: one.version, decision: 'accepted' },
    });
    assert.equal(withoutCsrf.status, 403);
    const keys = [randomUUID(), randomUUID()];
    const candidates = [one, two];
    const decisions = await Promise.all(candidates.map((r, i) => decision(owner, r, keys[i])));
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
    const win = decisions.findIndex((r) => r.status === 200);
    const winner = candidates[win],
      loser = candidates[1 - win];
    assert.equal(decisions[1 - win].code, 'capacity_conflict');
    assert.deepEqual(await decision(owner, winner, keys[win]), decisions[win]);
    assert.equal(
      (await decision(owner, winner, keys[win], { reason: '不同请求' })).code,
      'conflict',
    );
    assert.equal((await decision(owner, winner)).code, 'version_conflict');
    assert.equal((await decision(owner, decisions[win].data)).code, 'invalid_state');
    const actors = [student, other];
    assert.equal(
      (await detail(actors[win], a.id)).data.group_join_instructions,
      sample.revisions[0].content.group_join_instructions,
    );
    assert.equal((await detail(actors[1 - win], a.id)).data.group_join_instructions, undefined);
    const listing = await actors[win].request('/activities?scope=mine');
    assert.equal(
      Object.hasOwn(
        listing.data.items.find((r) => r.id === a.id),
        'group_join_instructions',
      ),
      false,
    );
    const page = (
      await roster(
        owner,
        a.id,
        '?q=' + (win ? me.student_no : otherStudent.student_no) + '&status=submitted&page_size=1',
      )
    ).data;
    assert.deepEqual(page.status_counts, {
      submitted: 1,
      waitlisted: 0,
      accepted: 0,
      rejected: 0,
      withdrawn: 0,
      exited: 0,
    });
    assert.equal(page.total, 1);
    assert.equal(page.accepted_count, 1);
    assert.equal(page.capacity, 1);
    assert.equal(page.items[0].id, loser.id);
    const empty = (
      await roster(
        owner,
        a.id,
        '?q=' + encodeURIComponent(page.items[0].student_name) + '&status=accepted&page=2',
      )
    ).data;
    assert.equal(empty.total, 0);
    assert.equal(empty.status_counts.submitted, 1);
    assert.equal(empty.accepted_count, 1);
    const events = await db.registrationDecisionEvent.findMany({ where: { activity_id: a.id } });
    assert.equal(events.length, 1);
    const { event_id, created_at, ...event } = events[0];
    assert.match(event_id, /^[0-9a-f-]{36}$/);
    assert.ok(created_at);
    assert.deepEqual(event, {
      event_type: 'registration_decided',
      activity_id: a.id,
      registration_id: winner.id,
      student_id: winner.student_id,
      registration_version: 2,
      status: 'accepted',
    });
    assert.equal(await db.registrationHistory.count({ where: { registration_id: loser.id } }), 1);
    await db.activityMember.delete({
      where: { activity_id_account_id: { activity_id: a.id, account_id: ownerId } },
    });
    assert.equal((await decision(owner, winner, keys[win])).status, 404);
    assert.equal((await roster(owner, a.id)).status, 404);
  });

  await t.test('候补和未录取记录可人工录取，已撤回和已退出保持原状态', async () => {
    const a = await activity();
    const one = (await post(student, a.id)).data;
    const two = (await post(other, a.id)).data;
    for (const [row, blocked, eligible] of [
      [one, 'withdrawn', 'waitlisted'],
      [two, 'exited', 'rejected'],
    ]) {
      await db.registration.update({
        where: { id: row.id },
        data: { status: blocked, version: 2 },
      });
      assert.equal((await decision(owner, { ...row, version: 2 })).code, 'invalid_state');
      await db.registration.update({
        where: { id: row.id },
        data: { status: eligible, version: 3 },
      });
      const accepted = await decision(owner, { ...row, version: 3 });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.data.version, 4);
    }
  });

  await t.test('停用学生、已结束活动与事件写入失败时无部分录取', async () => {
    const a = await activity();
    const row = (await post(other, a.id)).data;
    await db.account.update({ where: { id: otherStudent.account_id }, data: { active: false } });
    assert.equal((await decision(owner, row)).code, 'invalid_state');
    assert.equal((await post(other, a.id)).status, 401);
    await db.account.update({ where: { id: otherStudent.account_id }, data: { active: true } });
    for (const status of ['cancelled', 'completed']) {
      await db.activity.update({ where: { id: a.id }, data: { status } });
      assert.equal((await post(student, a.id)).code, 'invalid_state');
      assert.equal((await decision(owner, row)).code, 'invalid_state');
    }
    await db.activity.update({ where: { id: a.id }, data: { status: 'published' } });
    assert.equal((await decision(owner, row, undefined, { decision: 'waitlisted' })).status, 422);
    const key = randomUUID();
    // Only this isolated test DB is affected. Force the last write of the decision to fail.
    await db.$executeRaw`ALTER TABLE registration_decision_event ADD CONSTRAINT test_outbox_failure CHECK (false) NOT VALID`;
    try {
      assert.equal((await decision(dual, row, key, {}, '?scope=all')).status, 500);
    } finally {
      await db.$executeRaw`ALTER TABLE registration_decision_event DROP CONSTRAINT test_outbox_failure`;
    }
    assert.equal((await mine(other, row)).data.items[0].status, 'submitted');
    assert.equal(await db.registrationHistory.count({ where: { registration_id: row.id } }), 1);
    assert.equal(await db.commandReceipt.count({ where: { key } }), 0);
    assert.equal(
      await db.registrationDecisionEvent.count({ where: { registration_id: row.id } }),
      0,
    );
    assert.equal((await decision(dual, row, key, {}, '?scope=all')).status, 200);
    await db.roleGrant.delete({
      where: { account_id_role: { account_id: dualId, role: 'reviewer' } },
    });
    assert.equal((await decision(dual, row, key, {}, '?scope=all')).status, 403);
  });
}
