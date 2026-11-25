import { withFlowAccounts } from './flow-accounts-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/app.js';
import { prepareTestDatabase } from './prepare-test-database.mjs';
import { Database } from '../dist/database.js';

import { browser } from './api-client.mjs';

// Hold the target account until both HTTP writes are queued, in the requested order.
async function queuedAccountWrites(db, accountId, writes) {
  const pending = [];
  try {
    await db.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
      for (const write of writes) {
        pending.push(write());
        const deadline = Date.now() + 4000;
        while (true) {
          const [{ waiting }] = await db.$queryRaw`
            WITH RECURSIVE queue(pid) AS (
              SELECT ${pid}::int UNION
              SELECT s.pid FROM pg_stat_activity s JOIN queue q ON q.pid = ANY(pg_blocking_pids(s.pid))
                WHERE s.datname = current_database()
            ) SELECT count(*)::int - 1 AS waiting FROM queue`;
          if (waiting === pending.length) break;
          assert.ok(Date.now() < deadline, '并发写入未按预期等待目标账号');
          await delay(10);
        }
      }
    }, { timeout: 12000 });
  } finally {
    await Promise.allSettled(pending);
  }
  return Promise.all(pending);
}

test('收回负责人资格与添加协作者、交接主负责人并发', async t => {
  const password = randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: password });
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    const db = app.get(Database);
    const [teacher, owner, target] = Array.from({ length: 3 }, () => browser(base));
    await Promise.all([
      teacher.signIn('demo.teacher', password),
      owner.signIn('0000000002', '000002', 't1' + randomUUID()),
      target.signIn('0000000003', '000003', 't1' + randomUUID()),
    ]);
    const targetId = (await target.request('/me')).data.account_id;
    const ownerId = (await owner.request('/me')).data.account_id;
    const roles = '/admin/accounts/' + targetId + '/roles';
    const sample = await db.activity.findUniqueOrThrow({
      where: { activity_code: 'P2026-0001' }, include: { revisions: true },
    });
    await t.test('后台审计可按操作者和对象读回限期授权与协作者变更', async () => {
      const reason = '临时协助活动';
      const expires_at = new Date(Date.now() + 86400000).toISOString();
      const before = (await teacher.request(roles)).data;
      const grant = await teacher.write('PUT', roles, {
        expected_version: before.version, roles: [{ role: 'student' }, { role: 'organizer', expires_at }], reason,
      });
      assert.equal(grant.status, 200);
      const members = '/organizer/activities/' + sample.id + '/members';
      const team = (await owner.request(members)).data;
      const added = await owner.write('POST', members, { account_id: targetId, expected_version: team.version, reason });
      assert.equal(added.status, 200);

      async function readEvent(actorId, resourceId, action) {
        const query = new URLSearchParams({ actor_id: actorId, resource_id: resourceId });
        const page = await teacher.request('/admin/audit-events?' + query);
        assert.equal(page.status, 200);
        const matches = page.data.items.filter(event => event.action === action && event.reason === reason);
        assert.equal(matches.length, 1);
        return matches[0];
      }
      const account = await readEvent((await teacher.request('/me')).data.account_id, targetId, 'set_account_roles');
      assert.deepEqual(JSON.parse(account.before).roles, before.roles);
      assert.deepEqual(JSON.parse(account.after).roles, grant.data.roles);
      assert.equal(JSON.parse(account.after).roles.find(grant => grant.role === 'organizer').expires_at, expires_at);
      const member = await readEvent(ownerId, sample.id, 'add_activity_member');
      assert.equal(JSON.parse(member.before).version, team.version);
      assert.equal(JSON.parse(member.after).version, added.data.version);
      assert.deepEqual(JSON.parse(member.after).members.find(m => m.account_id === targetId),
        { account_id: targetId, member_role: 'collaborator' });
    });
    for (const transfer of [false, true]) {
      for (const revokeFirst of [true, false]) {
        const name = (transfer ? '交接' : '添加') + (revokeFirst ? '：先收回资格' : '：先写入团队');
        await t.test(name, async () => {
          const current = (await teacher.request(roles)).data;
          const grant = await teacher.write('PUT', roles, { expected_version: current.version,
            roles: [{ role: 'student' }, { role: 'organizer' }], reason: '安排值班' });
          assert.equal(grant.status, 200);
          const created = await owner.write('POST', '/organizer/activities', { ...sample.revisions[0].content, title: name });
          assert.equal(created.status, 201);
          const activity = '/organizer/activities/' + created.data.id;
          const members = activity + '/members';
          let before = (await owner.request(members)).data;
          if (transfer) {
            const joined = await owner.write('POST', members, { account_id: targetId,
              expected_version: before.version, reason: '预先加入为协作者' });
            assert.equal(joined.status, 200);
            before = joined.data;
          }
          const revoke = () => teacher.write('PUT', roles, { expected_version: grant.data.version,
            roles: [{ role: 'student' }], reason: name });
          const change = () => owner.write('POST', transfer ? activity + '/transfer-owner' : members, {
            [transfer ? 'target_account_id' : 'account_id']: targetId, expected_version: before.version, reason: name,
          });
          const results = await queuedAccountWrites(db, targetId, revokeFirst ? [revoke, change] : [change, revoke]);
          const [revoked, changed] = revokeFirst ? results : results.reverse();
          assert.equal(revoked.status, 200);
          assert.equal(revoked.data.version, grant.data.version + 1);
          assert.equal(changed.status, revokeFirst ? 422 : 200);
          if (revokeFirst) assert.equal(changed.details[0].field, transfer ? 'target_account_id' : 'account_id');
          const after = (await teacher.request(members)).data;
          if (revokeFirst) assert.deepEqual(after, before);
          else {
            assert.equal(after.version, before.version + 1);
            assert.deepEqual(after.items.filter(m => m.member_role === 'owner').map(m => m.account_id),
              [transfer ? targetId : ownerId]);
            assert.deepEqual(after.items.filter(m => m.member_role === 'collaborator').map(m => m.account_id),
              [transfer ? ownerId : targetId]);
            assert.equal(after.owner_unavailable_reason, transfer ? 'role_missing' : undefined);
          }
          assert.equal(await db.auditEvent.count({ where: { resource_id: created.data.id,
            action: transfer ? 'transfer_activity_owner' : 'add_activity_member', reason: name } }), revokeFirst ? 0 : 1);
          assert.equal(await db.auditEvent.count({ where: { resource_id: targetId, action: 'set_account_roles', reason: name } }), 1);
          assert.deepEqual((await target.request('/me')).data.roles, ['student']);
          assert.equal((await target.request(activity + '/registrations')).status, 403);
          assert.equal((await target.request('/me/hours')).status, 200);
        });
      }
    }
    await t.test('待发放的成员不能接任，主负责人领取临时凭证后恢复登录和团队资格', async () => {
      const activity = '/organizer/activities/' + sample.id;
      async function resetStudent(number) {
        const row = (await teacher.request('/admin/accounts?q=' + number)).data.items[0];
        const endpoint = '/admin/accounts/' + row.account_id + '/password-reset';
        const reset = await teacher.write('POST', endpoint, { expected_version: row.version, reason: '现场核对本人' });
        assert.equal(reset.status, 200);
        return { row, endpoint, version: reset.data.version };
      }
      const helper = await resetStudent('0000000004');
      const team = (await owner.request(activity + '/members')).data;
      assert.deepEqual((await owner.request(activity + '/member-candidates?student_no=0000000004')).data.items, []);
      assert.equal((await owner.write('POST', activity + '/transfer-owner', {
        expected_version: team.version, target_account_id: helper.row.account_id, reason: '安排接任',
      })).status, 422);
      const primary = await resetStudent('0000000002');
      const queue = '/organizer/activities?scope=all&owner_unavailable=true&q=' + sample.activity_code;
      assert.equal((await teacher.request(queue)).data.total, 1);
      assert.equal((await teacher.request(activity + '/members')).data.owner_unavailable_reason, 'credential_pending');

      const input = { expected_version: primary.version, reason: '向本人签发', temporary_password: 'T9' + randomUUID() };
      const key = randomUUID();
      const issue = () => teacher.write('POST', primary.endpoint, input, key);
      const issued = await issue();
      assert.equal(issued.status, 200);
      assert.deepEqual(await issue(), issued);
      assert.equal((await teacher.request(queue)).data.total, 0);
      await owner.signIn('0000000002', input.temporary_password, 'S9' + randomUUID());
      assert.equal((await owner.request(activity + '/members')).status, 200);
      const events = await db.auditEvent.findMany({ where: { resource_id: primary.row.account_id, action: 'issue_temporary_password' } });
      assert.equal(events.length, 1);
      assert.equal(events[0].after.credential_pending, false);
      assert.ok(!JSON.stringify([issued, events]).includes(input.temporary_password));
    });
  } finally {
    await app.close();
  }
});

test('没有长期技术管理员时，老师仍可办理学生账号，限期管理员可维护后台账号', async (t) => {
  const password = randomUUID();
  await prepareTestDatabase(t, { DEMO_STAFF_PASSWORD: password });
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1';
    // Simulate an installation created before a permanent administrator was required.
    await app.get(Database).account.update({ where: { username: 'demo.admin' }, data: { active: false } });
    const teacher = browser(base), tech = browser(base);
    await teacher.signIn('demo.teacher', password);
    const student = (await teacher.request('/admin/accounts?q=0000000001')).data.items[0];
    const path = '/admin/students/' + student.student_id;
    const off = await teacher.write('PATCH', path, {
      expected_version: student.student_version, status: 'inactive', reason: '离开试点',
    });
    assert.equal(off.status, 200);
    const on = await teacher.write('PATCH', path, {
      expected_version: off.data.version, status: 'active', reason: '已核实返校', pilot_scope_verified: true,
    });
    assert.equal(on.data.status, 'active');
    const accountPath = '/admin/accounts/' + student.account_id;
    const account = (await teacher.request(accountPath)).data;
    assert.equal((await teacher.write('POST', accountPath + '/password-reset', {
      expected_version: account.version, reason: '已核验学生本人',
    })).status, 200);

    const db = app.get(Database);
    const dual = await db.account.findUniqueOrThrow({ where: { username: 'demo.dual' } });
    const expires_at = new Date(Date.now() + 86400000);
    await db.roleGrant.create({ data: { account_id: dual.id, role: 'tech_admin', expires_at } });
    await tech.signIn('demo.dual', password);
    const staffPath = '/admin/accounts/' + (await teacher.request('/me')).data.account_id;
    const roles = (await tech.request(staffPath + '/roles')).data;
    const granted = await tech.write('PUT', staffPath + '/roles', {
      expected_version: roles.version, roles: [...roles.roles, { role: 'tech_admin', expires_at }], reason: '临时轮值',
    });
    assert.equal(granted.status, 200);
    let version = (await tech.request(staffPath)).data.version;
    for (const status of ['inactive', 'active']) {
      const result = await tech.write('PATCH', staffPath, { status, expected_version: version, reason: '办理轮岗' });
      assert.equal(result.status, 200);
      assert.equal(result.data.status, status);
      version = result.data.version;
    }
    assert.equal((await tech.write('PUT', staffPath + '/roles', {
      expected_version: granted.data.version, roles: roles.roles, reason: '临时轮值结束',
    })).status, 200);
  } finally {
    await app.close();
  }
});

test('添加、交接、移除活动成员与后台接管', t => withFlowAccounts(t, async ({
  db, student, owner, other, teacher, sample,
}) => {
  const privateDraft = await owner.write('POST', '/organizer/activities', { title: '另一项负责人的草稿' });
  assert.equal(privateDraft.status, 201);
  const path = '/organizer/activities/' + privateDraft.data.id;

  await t.test('精确查找有效负责人并加入本活动，重复请求只写一次', async () => {
    const team = '/organizer/activities/' + sample.id + '/members';
    const find = (actor, number) => actor.request(team.replace('/members', '/member-candidates?student_no=') + number);
    const number = '0000000003';
    const account_id = (await other.request('/me')).data.account_id;
    const expected_version = (await owner.request(team)).data.version;
    const body = { account_id, expected_version, reason:'协助现场签到' };
    assert.equal((await find(owner, '003')).status, 422);
    assert.deepEqual((await find(owner, number)).data.items, [{ account_id, student_no:number, display_name:'同学乙' }]);
    assert.deepEqual((await find(owner, '0000000001')).data.items, []);
    assert.equal((await find(teacher, number)).status, 200);
    assert.equal((await find(other, number)).status, 404);
    assert.equal((await other.request(team)).status, 404);
    const grant = {account_id_role:{account_id, role:'organizer'}};
    await db.roleGrant.update({where:grant,data:{expires_at:new Date(0)}});
    assert.deepEqual((await find(owner, number)).data.items, []);
    assert.equal((await owner.write('POST',team,body)).status, 422);
    await db.roleGrant.update({where:grant,data:{expires_at:null}});
    const key = randomUUID();
    const attempts = await Promise.all([owner.write('POST', team, body, key), owner.write('POST', team, body, key)]);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(attempts[0].status, 200);
    const added = attempts[0].data;
    assert.equal(added.version, expected_version + 1);
    assert.deepEqual(added.items.filter(member => member.account_id === account_id).map(member => member.member_role), ['collaborator']);
    assert.equal((await owner.write('POST',team,body)).code, 'version_conflict');
    assert.deepEqual((await owner.write('POST',team,{...body,expected_version:added.version})).data, added);
    const duplicate = await owner.write('POST', team, {
      ...body, account_id: account_id.toUpperCase(), expected_version: added.version,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.data, added);
    assert.equal((await other.request(team.replace('/members','/registrations'))).status, 200);
    assert.equal((await other.request(path + '/registrations')).status, 404);
    assert.equal((await find(other, number)).status, 404);
    assert.equal((await other.write('POST',team,body)).status, 404);
    const events = await db.auditEvent.findMany({where:{resource_id:sample.id, action:'add_activity_member'}});
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, body.reason);
    assert.equal(events[0].actor_id, (await owner.request('/me')).data.account_id);
    assert.equal(events[0].before.members.length + 1, events[0].after.members.length);
    assert.deepEqual(Object.keys(events[0].after.members[0]).sort(), ['account_id','member_role']);
  });
  await t.test('交接复核资格、版本，并发只产生一次换任', async () => {
    const base = '/organizer/activities/' + sample.id;
    const members = () => owner.request(base + '/members');
    const before = (await members()).data;
    const target = (await other.request('/me')).data.account_id;
    const oldOwner = (await owner.request('/me')).data.account_id;
    const body = { expected_version: before.version, target_account_id: target.toUpperCase(), reason: '现场交接' };
    const post = (user, data, key) => user.write('POST', base + '/transfer-owner', data, key);
    assert.equal((await post(other, body)).status, 404);
    assert.equal((await post(owner, { ...body, target_account_id: oldOwner })).status, 422);
    assert.equal((await post(owner, { ...body, expected_version: before.version - 1 })).status, 409);
    const where = { account_id_role: { account_id: target, role: 'organizer' } };
    await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
    assert.equal((await post(owner, body)).status, 422);
    await db.roleGrant.update({ where, data: { expires_at: null } });
    const keys = [randomUUID(), randomUUID()];
    const attempts = await Promise.all(keys.map(key => post(owner, body, key)));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 404]);
    const replay = await post(owner, body, keys[attempts.findIndex(r => r.status === 200)]);
    assert.equal(replay.status, 404);
    assert.equal(replay.code, 'not_found');
    assert.equal(replay.data, undefined);
    const after = (await members()).data;
    assert.equal(after.version, before.version + 1);
    assert.deepEqual(after.items.filter(m => m.member_role === 'owner').map(m => m.account_id), [target]);
    assert.equal(after.items.find(m => m.account_id === oldOwner).member_role, 'collaborator');
    assert.equal(await db.auditEvent.count({ where: { resource_id: sample.id, action: 'transfer_activity_owner', actor_id: oldOwner, reason: body.reason } }), 1);
  });
  await t.test('移除协作者只撤销该活动访问权，重放只记一次审计', async () => {
    const base = '/organizer/activities/' + sample.id;
    const team = base + '/members';
    const before = (await other.request(team)).data;
    const formerOwner = (await owner.request('/me')).data;
    const currentOwner = (await other.request('/me')).data.account_id;
    const endpoint = team + '/' + formerOwner.account_id;
    const body = { expected_version: before.version, reason: '现场工作已交接' };
    for (const route of ['/registrations', '/attendance'])
      assert.equal((await owner.request(base + route)).status, 200);
    assert.equal((await owner.write('DELETE', endpoint, body)).status, 404);
    assert.equal((await other.write('DELETE', team + '/' + currentOwner, body)).status, 422);
    assert.equal((await other.write('DELETE', endpoint, { ...body, reason: '  ' })).status, 422);
    assert.equal((await other.write('DELETE', endpoint, { ...body, expected_version: before.version - 1 })).code, 'version_conflict');
    const key = randomUUID();
    const removed = await other.write('DELETE', endpoint, body, key);
    assert.equal(removed.status, 200);
    assert.deepEqual(await other.write('DELETE', endpoint, body, key), removed);
    assert.equal(removed.data.version, before.version + 1);
    assert.deepEqual(removed.data.items, before.items.filter(m => m.account_id !== formerOwner.account_id));
    for (const route of ['/registrations', '/attendance'])
      assert.equal((await owner.request(base + route)).status, 404);
    assert.equal((await owner.request('/me/hours')).status, 200);
    assert.equal((await owner.request(path + '/members')).status, 200);
    assert.deepEqual((await owner.request('/me')).data.roles, formerOwner.roles);
    const events = await db.auditEvent.findMany({ where: { resource_id: sample.id, action: 'remove_activity_member' } });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, currentOwner);
    assert.equal(events[0].reason, body.reason);
    const snapshot = data => ({ version: data.version, members: data.items.map(({ account_id, member_role }) => ({ account_id, member_role })) });
    assert.deepEqual(events[0].before, snapshot(before));
    assert.deepEqual(events[0].after, snapshot(removed.data));
  });
  await t.test('后台修复到期主负责人，旧版本和资格恢复均不能覆盖现状', async () => {
    const path = '/admin/activities/' + sample.id + '/members';
    const read = '/organizer/activities/' + sample.id + '/members';
    const before = (await teacher.request(read)).data;
    const oldId = (await other.request('/me')).data.account_id;
    const nextId = (await owner.request('/me')).data.account_id;
    const assignments = before.items.map(({ account_id, member_role }) => ({ account_id, member_role }));
    const incoming = { account_id: nextId, member_role: 'collaborator' };
    const add = { expected_version: before.version, require_unavailable_owner: true,
      members: [...assignments, incoming], reason: '补入接任人' };
    const put = (body, key) => teacher.write('PUT', path, body, key);
    const where = { account_id_role: { account_id: oldId, role: 'organizer' } };
    const list = '/organizer/activities?scope=all';
    const pending = list + '&owner_unavailable=true';
    const activityQuery = '&q=' + sample.activity_code;
    assert.equal((await teacher.request(list + activityQuery)).data.items[0].owner_unavailable, false);
    assert.equal((await teacher.request(list + '&owner_unavailable=unknown')).status, 422);
    for (const [client, endpoint] of [[student, '/activities?q=' + sample.activity_code],
      [other, '/organizer/activities?scope=managed' + activityQuery]]) {
      const rows = (await client.request(endpoint)).data.items;
      assert.ok(rows.some(activity => activity.id === sample.id));
      assert.ok(rows.every(activity => !('owner_unavailable' in activity)));
      assert.equal((await client.request(endpoint + '&owner_unavailable=true')).status, 403);
    }
    assert.equal((await put(add)).status, 409);
    await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
    assert.equal((await teacher.request(read)).data.owner_unavailable_reason, 'role_expired');
    const pages = await Promise.all([1, 2].map(page => teacher.request(pending + '&q=P2026-000&page_size=1&page=' + page)));
    assert.deepEqual(pages.map(page => page.data.total), [2, 2]);
    assert.deepEqual(pages.flatMap(page => page.data.items.map(row => [row.activity_code, row.owner_unavailable])),
      [['P2026-0001', true], ['P2026-0002', true]]);
    assert.equal((await teacher.request(list + '&owner_unavailable=false' + activityQuery)).data.total, 0);
    assert.equal((await other.request(read)).status, 403);
    assert.equal((await other.request('/me/hours')).status, 200);
    assert.equal((await owner.write('PUT', path, add)).status, 403);
    assert.equal((await put({ ...add, members: [...add.members, incoming] })).status, 422);
    const assign = member => ({ ...member, member_role: member.account_id === nextId ? 'owner' : 'collaborator' });
    assert.equal((await put({ ...add, members: add.members.map(assign) })).status, 422);
    const added = await put(add);
    assert.equal(added.status, 200);
    const repair = { ...add, expected_version: added.data.version, members: add.members.map(assign), reason: '老师核对后交接' };
    assert.equal((await put({ ...repair, members: repair.members.filter(m => m.account_id !== oldId) })).status, 422);
    const targetGrant = { account_id_role: { account_id: nextId, role: 'organizer' } };
    await db.roleGrant.update({ where: targetGrant, data: { expires_at: new Date(0) } });
    assert.equal((await put(repair)).status, 422);
    await db.roleGrant.update({ where: targetGrant, data: { expires_at: null } });
    const keys = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all(keys.map(key => put(repair, key)));
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const winner = outcomes.findIndex(r => r.status === 200);
    assert.deepEqual(await put(repair, keys[winner]), outcomes[winner]);
    const after = (await teacher.request(read)).data;
    assert.equal(after.owner_unavailable_reason, undefined);
    assert.equal((await teacher.request(pending + activityQuery)).data.total, 0);
    assert.deepEqual(after.items.filter(m => m.member_role === 'owner').map(m => m.account_id), [nextId]);
    assert.equal(after.items.find(m => m.account_id === oldId).member_role, 'collaborator');
    assert.equal((await owner.request(read)).status, 200);
    assert.equal((await other.request(read)).status, 403);
    const events = await db.auditEvent.findMany({ where: { resource_id: sample.id, action: 'set_activity_members', reason: repair.reason } });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
    assert.equal(events[0].before.version + 1, events[0].after.version);
  });
}));
