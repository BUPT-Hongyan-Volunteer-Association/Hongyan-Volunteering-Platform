import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browser } from './api-client.mjs';
import { withFlowAccounts } from './flow-accounts-fixture.mjs';

async function raceAdminChanges(base, changes) {
  async function snapshot({ client, path }) {
    const [account, grants] = await Promise.all([client.request(path), client.request(path + '/roles')]);
    assert.equal(account.status, 200);
    assert.equal(grants.status, 200);
    return { ...account.data, roles_version: grants.data.version };
  }

  const before = await Promise.all(changes.map(snapshot));
  for (const account of before) {
    assert.equal(account.status, 'active');
    assert.ok(!account.credential_pending);
    assert.deepEqual(account.roles.find(grant => grant.role === 'tech_admin'), { role: 'tech_admin' });
  }
  const results = await Promise.all(changes.map(change => change.write()));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const kept = results.findIndex(result => result.status === 409);
  assert.equal(results[kept].code, 'invalid_state');

  // Read through the original session before trying the same credentials in a fresh session.
  const account = await snapshot(changes[kept]);
  assert.deepEqual(account, before[kept]);
  const fresh = browser(base);
  await fresh.signIn(account.username, changes[kept].password);
  const me = await fresh.request('/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.account_id, account.account_id);
  assert.ok(me.data.roles.includes('tech_admin'));
  return results;
}

test('账号凭证、角色授权与启停', t => withFlowAccounts(t, async ({
  db, base, student, owner, other, teacher, sample, staffPassword, adminPassword, ownerPassword,
}) => {
  await t.test('创建后台账号仅限技术管理员，重放和重名不会多建或泄露凭证', async () => {
    const tech = browser(base);
    await tech.signIn('demo.dual', staffPassword);
    const techId = (await tech.request('/me')).data.account_id;
    // The seeded permanent administrator remains available while this grant expires.
    await db.roleGrant.create({ data: { account_id: techId, role: 'tech_admin' } });
    const endpoint = '/admin/staff-accounts';
    const body = { username: 'staff.fixture', display_name: '独立老师', role: 'reviewer', reason: '新教师入职' };
    const key = randomUUID();
    const post = (data, token) => tech.write('POST', endpoint, data, token);
    assert.equal((await teacher.write('POST', endpoint, body)).status, 403);
    assert.equal((await student.write('POST', endpoint, body)).status, 403);
    assert.equal((await post({ ...body, role: 'student' })).status, 422);
    assert.equal((await post({ ...body, reason: '  ' })).status, 422);
    const [created, replay] = await Promise.all([post(body, key), post(body, key)]);
    assert.equal(created.status, 201);
    assert.deepEqual(created, replay);
    assert.deepEqual(Object.keys(created.data).sort(), ['account_id', 'roles', 'version']);
    assert.deepEqual(created.data.roles, [{ role: 'reviewer' }]);
    assert.equal((await post({ ...body, role: 'tech_admin' }, key)).status, 409);
    assert.equal((await post(body)).status, 409);
    const lookup = '/admin/accounts?username=' + body.username;
    assert.equal((await teacher.request(lookup)).data.total, 0);
    const account = (await tech.request(lookup)).data.items[0];
    assert.equal(account.account_id, created.data.account_id);
    assert.equal(account.credential_pending, true);
    assert.equal(account.student_id, undefined);
    const row = await db.account.findUniqueOrThrow({ where: { id: account.account_id } });
    assert.equal(row.password_hash, null);
    const guest = browser(base);
    await guest.request('/auth/csrf');
    assert.equal((await guest.request('/auth/login', { method: 'POST', body: { username: body.username, password: '000002' } })).status, 401);
    const events = await db.auditEvent.findMany({ where: { resource_id: account.account_id, action: 'create_staff_account' } });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, body.reason);
    assert.deepEqual(events[0].after, { status: 'active', credential_pending: true, roles: [{ role: 'reviewer' }] });
    assert.equal(events[0].actor_id, techId);
    const second = { ...body, username: 'new.technical', role: 'tech_admin' };
    const race = await Promise.all([post(second), post(second)]);
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
    // A cached success must not outlive the operator's technical role.
    await db.roleGrant.update({ where: { account_id_role: { account_id: techId, role: 'tech_admin' } }, data: { expires_at: new Date(0) } });
    assert.equal((await post(body, key)).status, 403);

  });
  await t.test('后台账号停用撤销所有会话，重新启用须登录且保留角色历史', async () => {
    const admin = browser(base), secondSession = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    await secondSession.signIn('demo.teacher', staffPassword);
    const originalAdminId = (await admin.request('/me')).data.account_id;
    const teacherId = (await teacher.request('/me')).data.account_id;
    const target = '/admin/accounts/' + teacherId;
    const original = (await admin.request(target)).data;
    const body = { expected_version: original.version, status: 'inactive', reason: '工作交接' };
    const write = (data, key) => admin.write('PATCH', target, data, key);
    assert.equal((await teacher.write('PATCH', target, body)).status, 403);
    const studentId = (await student.request('/me')).data.account_id;
    assert.equal((await admin.write('PATCH', '/admin/accounts/' + studentId, body)).status, 422);
    assert.equal((await write({ ...body, reason: ' ' })).status, 422);
    const roles = (await admin.request(target + '/roles')).data;
    const key = randomUUID();
    const off = await write(body, key);
    assert.equal(off.status, 200);
    assert.deepEqual(off.data, { ...original, version: original.version + 1, status: 'inactive' });
    assert.deepEqual(await write(body, key), off);
    assert.deepEqual((await write({ ...body, expected_version: off.data.version })).data, off.data);
    assert.equal((await write(body)).code, 'version_conflict');
    assert.equal((await teacher.request('/me')).status, 401);
    assert.equal((await secondSession.request('/me')).status, 401);
    await secondSession.request('/auth/csrf');
    assert.equal((await secondSession.request('/auth/login', { method: 'POST', body: { username: 'demo.teacher', password: staffPassword } })).status, 401);
    const on = await write({ expected_version: off.data.version, status: 'active', reason: '恢复履职' });
    assert.deepEqual(on.data, { ...original, version: off.data.version + 1 });
    assert.deepEqual((await admin.request(target + '/roles')).data, roles);
    assert.equal((await teacher.request('/me')).status, 401);
    await teacher.signIn('demo.teacher', staffPassword);
    assert.equal((await teacher.request('/me')).data.account_id, teacherId);
    const events = await db.auditEvent.findMany({ where: { resource_id: teacherId, action: 'set_account_status' }, orderBy: { created_at: 'asc' } });
    assert.deepEqual(events.map(e => [e.reason, e.before.status, e.after.status]), [
      ['工作交接', 'active', 'inactive'], ['恢复履职', 'inactive', 'active'],
    ]);
    assert.ok(events.every(e => e.actor_id === originalAdminId));
  });

  await t.test('并发停用两个永久管理员只成功一次，限期和待发凭证的账号不能兜底', async () => {
    const permanent = browser(base), backup = browser(base);
    await permanent.signIn('demo.admin', adminPassword);
    await backup.signIn('demo.dual', staffPassword);
    const ids = [(await permanent.request('/me')).data.account_id, (await backup.request('/me')).data.account_id];
    const where = { account_id_role: { account_id: ids[1], role: 'tech_admin' } };
    await db.roleGrant.update({ where, data: { expires_at: new Date(Date.now() + 86400000) } });
    const body = { expected_version: 1, status: 'inactive', reason: '管理员交班' };
    const paths = ids.map(id => '/admin/accounts/' + id);
    assert.equal((await permanent.write('PATCH', paths[0], body)).code, 'invalid_state');
    assert.equal((await permanent.request('/me')).status, 200);
    await db.roleGrant.update({ where, data: { expires_at: null } });
    const clients = [permanent, backup];
    const results = await raceAdminChanges(base, clients.map((client, i) => ({
      client, path: paths[i], password: i === 0 ? adminPassword : staffPassword,
      write: () => client.write('PATCH', paths[i], body),
    })));
    const disabled = results.findIndex(r => r.status === 200), kept = 1 - disabled;
    assert.equal((await clients[disabled].request('/me')).status, 401);
    assert.equal(await db.auditEvent.count({ where: { action: 'set_account_status', resource_id: { in: ids } } }), 1);
    assert.equal((await clients[kept].write('PATCH', paths[disabled], {
      status: 'active', expected_version: results[disabled].data.version, reason: '恢复履职',
    })).status, 200);
    await db.roleGrant.update({ where, data: { expires_at: new Date(0) } });
  });
  await t.test('账号只读范围先于分页，角色和详情不泄露高权限资料', async () => {
    const expires = new Date('2099-12-31T15:59:00Z');
    const create = (username, roles) => db.account.create({ data: {
      username, display_name: '合成同名', password_hash: 'not-a-login', roles_version: 3,
      student: { create: { student_no: username } },
      roles: { create: roles.map(role => ({ role, ...(role === 'organizer' && { expires_at: expires }) })) },
    } });
    const hidden = await create('0999000001', ['student', 'tech_admin']);
    const firstVisible = await create('0999000002', ['student', 'organizer']);
    await create('0999000003', ['student']);
    const path = '/admin/accounts';
    const lookup = query => teacher.request(path + '?' + new URLSearchParams(query));
    const exact = (await lookup({ q: firstVisible.username })).data;
    assert.equal(exact.total, 1);
    assert.deepEqual(exact.items.map(item => item.account_id), [firstVisible.id]);
    const page = (await lookup({ q: '合成同名', page_size: 1 })).data;
    assert.equal(page.total, 2);
    assert.equal(page.items[0].username, firstVisible.username);
    assert.equal((await lookup({ q: hidden.username })).data.total, 0);
    assert.equal((await lookup({ q: '合成同名', role: 'organizer', status: 'active' })).data.total, 1);
    assert.equal((await lookup({ role: 'other' })).status, 422);
    assert.equal((await student.request(path)).status, 403);
    for (const suffix of ['', '/roles']) {
      assert.equal((await teacher.request(path + '/' + hidden.id + suffix)).status, 403);
    }
    const detail = (await teacher.request(path + '/' + firstVisible.id)).data;
    assert.deepEqual(Object.keys(detail).sort(), ['account_id','display_name','roles','roles_version','status','student_id','student_version','username','version']);
    const grants = (await teacher.request(path + '/' + firstVisible.id + '/roles')).data;
    assert.equal(grants.version, 3);
    assert.equal(detail.version, 1);
    assert.deepEqual(grants.roles, [{ role:'student' }, { role:'organizer', expires_at:expires.toISOString() }]);
  });
  await t.test('资格授予、到期和回收立即作用于原会话，角色并发及重放只记一次', async (t) => {
    const { account_id } = (await student.request('/me')).data;
    const path = '/admin/accounts/' + account_id + '/roles';
    const original = (await teacher.request(path)).data;
    const now = Date.now(), expires_at = new Date(now + 120000).toISOString();
    t.mock.timers.enable({ apis:['Date'], now });
    const body = { expected_version: original.version, reason:'合成授权核对',
      roles:[...original.roles, { role:'organizer', expires_at }] };
    const key = randomUUID();
    const put = (payload, token) => teacher.write('PUT', path, payload, token);
    assert.equal((await student.write('PUT', path, body)).status, 403);
    for (const roles of [[], [{role:'student', expires_at}], [...original.roles, {role:'reviewer'}]]) {
      assert.equal((await put({...body, roles})).status, 403);
    }
    const writes = await Promise.all([put(body, key), put(body, key)]);
    assert.equal(writes[0].status, 200);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal((await put({...body, reason:'不同内容'}, key)).code, 'conflict');
    assert.equal((await put(body)).code, 'version_conflict');
    const managed = () => student.request('/organizer/activities');
    assert.equal((await managed()).status, 200);
    assert.equal((await student.request('/organizer/activities/' + sample.id + '/registrations')).status, 404);
    t.mock.timers.setTime(Date.parse(expires_at));
    assert.deepEqual((await student.request('/me')).data.roles, ['student']);
    assert.equal((await managed()).status, 403);
    const permanent = {...body, expected_version:writes[0].data.version, roles:[...original.roles, {role:'organizer'}]};
    const renewals = await Promise.all([put(permanent), put(permanent)]);
    assert.deepEqual(renewals.map(result => result.status).sort(), [200,409]);
    assert.equal((await managed()).status, 200);
    const revoked = await put({...body, expected_version:permanent.expected_version + 1, roles:original.roles});
    assert.equal(revoked.status, 200);
    assert.equal((await managed()).status, 403);
    assert.equal((await student.request('/me/registrations')).status, 200);
    const events = await db.auditEvent.findMany({where:{resource_id:account_id, action:'set_account_roles'}, orderBy:{created_at:'asc'}});
    assert.equal(events.length, 3);
    assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
    assert.equal(events[0].reason, body.reason);
    assert.deepEqual(events[0].before, {roles:original.roles});
    assert.deepEqual(events[0].after, {roles:body.roles});
    await db.roleGrant.create({data:{account_id, role:'reviewer'}});
    assert.equal((await put(body, key)).status, 403);
  });
  await t.test('高权限授权按角色版本生效，老师原会话在到期和收回后立即恢复原范围', async (t) => {
    const admin = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    const adminId = (await admin.request('/me')).data.account_id;
    const teacherId = (await teacher.request('/me')).data.account_id;
    const target = '/admin/accounts/' + teacherId;
    const path = target + '/roles';
    const privileged = '/admin/accounts/' + adminId;
    const original = (await admin.request(path)).data;
    const accountVersion = (await admin.request(target)).data.version;
    const now = Date.now(), expires_at = new Date(now + 120000).toISOString();
    t.mock.timers.enable({ apis: ['Date'], now });
    const body = { expected_version: original.version, reason: '临时技术值班',
      roles: [...original.roles, { role: 'tech_admin', expires_at }] };
    assert.equal((await teacher.write('PUT', path, body)).status, 403);
    const key = randomUUID();
    const issued = await admin.write('PUT', path, body, key);
    assert.equal(issued.status, 200);
    assert.deepEqual(await admin.write('PUT', path, body, key), issued);
    assert.equal((await admin.write('PUT', path, body)).code, 'version_conflict');
    assert.equal((await teacher.request(privileged)).status, 200);
    t.mock.timers.setTime(Date.parse(expires_at));
    assert.equal((await teacher.request(privileged)).status, 403);
    assert.deepEqual((await teacher.request('/me')).data.roles, ['reviewer']);
    const renew = { ...body, expected_version: issued.data.version, roles: [...original.roles, { role: 'tech_admin' }] };
    assert.equal((await admin.write('PUT', path, renew)).status, 200);
    assert.equal((await teacher.request(privileged)).status, 200);
    const revoked = await admin.write('PUT', path, { ...body, roles: original.roles, expected_version: renew.expected_version + 1 });
    assert.deepEqual(revoked.data, { ...original, version: original.version + 3 });
    assert.equal((await teacher.request(privileged)).status, 403);
    assert.equal((await admin.request(target)).data.version, accountVersion);
    const events = await db.auditEvent.findMany({ where: { resource_id: teacherId, action: 'set_account_roles' } });
    assert.equal(events.length, 3);
    const issuedEvent = events.find(e => e.after.roles.some(g => g.expires_at === expires_at));
    assert.equal(issuedEvent.actor_id, adminId);
    assert.equal(issuedEvent.reason, body.reason);
    assert.deepEqual(issuedEvent.before, { roles: original.roles });
    assert.deepEqual(issuedEvent.after, { roles: body.roles });
  });
  await t.test('办理老师审核员角色时保留原学生身份和已到期的其他角色', async () => {
    const admin = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    const account_id = (await other.request('/me')).data.account_id;
    await db.roleGrant.update({ where: { account_id_role: { account_id, role: 'organizer' } }, data: { expires_at: new Date(0) } });
    const path = '/admin/accounts/' + account_id + '/roles';
    const original = (await admin.request(path)).data;
    const set = (version, roles) => admin.write('PUT', path, { expected_version: version, roles, reason: '审核轮岗' });
    assert.equal((await set(original.version, [{ role: 'reviewer' }])).status, 403);
    const updated = await set(original.version, [...original.roles, { role: 'reviewer' }]);
    assert.equal(updated.status, 200);
    assert.equal((await other.request('/admin/accounts')).status, 200);
    assert.equal((await other.request('/me/hours')).status, 200);
    const restored = await set(updated.data.version, original.roles);
    assert.deepEqual(restored.data.roles, original.roles);
    assert.equal((await other.request('/admin/accounts')).status, 403);
  });
  await t.test('限期、撤权和停用并发时保留一个长期管理员，失败的写入不改变角色或状态', async () => {
    const admin = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    const primary = '/admin/accounts/' + (await admin.request('/me')).data.account_id;
    const backup = '/admin/accounts/' + (await teacher.request('/me')).data.account_id;
    const expires_at = new Date(Date.now() + 86400000).toISOString();
    const set = (client, path, version, roles) => client.write('PUT', path + '/roles', {
      expected_version: version, reason: '管理员轮值', roles,
    });
    const state = async (path, client = admin) => (await client.request(path + '/roles')).data;
    const primaryRoles = (await state(primary)).roles;
    const backupRoles = (await state(backup)).roles;
    const limited = primaryRoles.map(g => g.role === 'tech_admin' ? { ...g, expires_at } : g);
    const sole = await state(primary);
    assert.equal((await set(admin, primary, sole.version, sole.roles.filter(g => g.role !== 'tech_admin'))).code, 'invalid_state');
    assert.deepEqual(await state(primary), sole);
    for (const [primaryAction, backupAction] of [['limit', 'revoke'], ['limit', 'disable'], ['revoke', 'disable']]) {
      const requestedRoles = primaryAction === 'limit' ? limited : primaryRoles.filter(g => g.role !== 'tech_admin');
      const original = await state(backup);
      const granted = await set(admin, backup, original.version, [...backupRoles, { role: 'tech_admin' }]);
      assert.equal(granted.status, 200);
      const primaryVersion = (await state(primary)).version;
      const accountVersion = (await admin.request(backup)).data.version;
      const results = await raceAdminChanges(base, [
        { client: admin, path: primary, password: adminPassword,
          write: () => set(admin, primary, primaryVersion, requestedRoles) },
        { client: teacher, path: backup, password: staffPassword,
          write: () => backupAction === 'revoke' ? set(teacher, backup, granted.data.version, backupRoles)
            : teacher.write('PATCH', backup, { expected_version: accountVersion, status: 'inactive', reason: '值班交接' }) },
      ]);
      const primaryWon = results[0].status === 200;
      const remaining = primaryWon ? teacher : admin;
      const primaryState = await state(primary, remaining);
      assert.deepEqual(primaryState.roles, primaryWon ? requestedRoles : primaryRoles);
      const backupState = await state(backup, remaining);
      assert.deepEqual(backupState.roles, !primaryWon && backupAction === 'revoke' ? backupRoles : granted.data.roles);
      const backupAccount = (await remaining.request(backup)).data;
      assert.equal(backupAccount.status, !primaryWon && backupAction === 'disable' ? 'inactive' : 'active');
      if (primaryWon)
        assert.equal((await set(remaining, primary, primaryVersion + 1, primaryRoles)).status, 200);
      if (!primaryWon && backupAction === 'disable') {
        assert.equal((await admin.write('PATCH', backup, {
          expected_version: accountVersion + 1, status: 'active', reason: '恢复履职',
        })).status, 200);
        await teacher.signIn('demo.teacher', staffPassword);
      }
      assert.equal((await set(admin, backup, backupState.version, backupRoles)).status, 200);
    }
  });
  await t.test('档案修正使用学生版本，旧状态表单须重新核对，姓名和班级修正脱敏记录', async () => {
    const row = (await teacher.request('/admin/students?q=0999000003')).data.items[0];
    const path = '/admin/students/' + row.id;
    const patch = { expected_version: row.version, reason: '核对学院档案', name: '合成测试学生', class_name: '0123456789' };
    assert.equal((await teacher.write('PATCH', path, { ...patch, class_name: '123' })).status, 422);
    const changed = await teacher.write('PATCH', path, patch);
    assert.equal(changed.status, 200);
    assert.equal(changed.data.class_name, patch.class_name);
    assert.equal((await teacher.write('PATCH', path, { expected_version: row.version, reason: '旧表单', status: 'inactive' })).code, 'version_conflict');
    assert.equal((await teacher.request('/admin/accounts/' + row.account_id)).data.status, 'active');
    const event = await db.auditEvent.findFirstOrThrow({ where: { resource_id: row.id, action: 'update_student' } });
    assert.equal(event.after.class_name, '******6789');
    assert.equal(event.after.name, '合＊');
    assert.equal(event.after.version, row.version + 1);
  });
  await t.test('老师停用与恢复学生负责人需核实试点范围，两份旧会话失效且身份和报名历史保留', async () => {
    const second = browser(base);
    await second.signIn('0000000002', ownerPassword);
    const me = (await owner.request('/me')).data;
    const id = me.student.id;
    const accountPath = '/admin/accounts/' + me.account_id;
    const path = '/admin/students/' + id;
    const before = (await teacher.request(accountPath)).data;
    const roles = (await teacher.request(accountPath + '/roles')).data;
    const submitted_at = new Date();
    await db.registration.create({ data: { activity_id: sample.id, student_id: id, status: 'submitted', submitted_at,
      history: { create: { version: 1, status: 'submitted', submitted_at, changed_at: submitted_at } } } });
    const history = await db.registration.findMany({ where: { student_id: id } });
    const off = { expected_version: before.student_version, status: 'inactive', reason: '本期暂停参加试点' };
    const key = randomUUID();
    assert.equal((await owner.write('PATCH', path, off)).status, 403);
    const results = await Promise.all([teacher.write('PATCH', path, off, key), teacher.write('PATCH', path, off, key)]);
    assert.equal(results[0].status, 200);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].data.version, before.student_version + 1);
    assert.equal((await teacher.write('PATCH', path, off)).code, 'version_conflict');
    assert.equal((await owner.request('/me')).status, 401);
    assert.equal((await second.request('/me')).status, 401);
    await second.request('/auth/csrf');
    assert.equal((await second.request('/auth/login', { method: 'POST', body: { username: me.username, password: ownerPassword } })).status, 401);
    const on = { expected_version: results[0].data.version, status: 'active', reason: '已核对本期学院名单' };
    for (const flag of [{}, { pilot_scope_verified: false }])
      assert.equal((await teacher.write('PATCH', path, { ...on, ...flag })).status, 422);
    assert.equal((await teacher.write('PATCH', path, { ...on, pilot_scope_verified: true })).status, 200);
    assert.equal((await second.request('/me')).status, 401);
    assert.equal((await owner.request('/me')).status, 401);
    await owner.signIn(me.username, ownerPassword);
    assert.equal((await owner.request('/me/hours')).status, 200);
    assert.deepEqual((await teacher.request(accountPath + '/roles')).data, roles);
    assert.deepEqual(await db.registration.findMany({ where: { student_id: id } }), history);
    assert.deepEqual((await teacher.request(accountPath)).data, { ...before, student_version: before.student_version + 2, version: before.version + 2 });
    const events = await db.auditEvent.findMany({ where: { resource_id: id, action: 'update_student' }, orderBy: { created_at: 'asc' } });
    assert.deepEqual(events.map(e => [e.before.status, e.after.status, e.reason]), [
      ['active', 'inactive', off.reason], ['inactive', 'active', on.reason],
    ]);
    assert.equal(events[1].after.pilot_scope_verified, true);
    assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
    await db.roleGrant.create({ data: { account_id: me.account_id, role: 'reviewer' } });
    assert.equal((await teacher.write('PATCH', path, off, key)).status, 403);
    await db.roleGrant.delete({ where: { account_id_role: { account_id: me.account_id, role: 'reviewer' } } });
  });

  await t.test('学生档案停用与另一管理员改限期并发，仅能失去一名长期管理员', async () => {
    const admin = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    const primaryPath = '/admin/accounts/' + (await admin.request('/me')).data.account_id;
    const me = (await owner.request('/me')).data;
    const target = '/admin/accounts/' + me.account_id;
    const studentPath = '/admin/students/' + me.student.id;
    const primary = (await admin.request(primaryPath + '/roles')).data;
    const original = (await admin.request(target + '/roles')).data;
    const grant = await admin.write('PUT', target + '/roles', { expected_version: original.version,
      roles: [...original.roles, {role: 'tech_admin'}], reason: '管理员轮值' });
    assert.equal(grant.status, 200);
    const status = { expected_version: (await admin.request(target)).data.student_version, status: 'inactive', reason: '结束轮值' };
    const expires_at = new Date(Date.now() + 86400000).toISOString();
    const results = await raceAdminChanges(base, [
      { client: admin, path: primaryPath, password: adminPassword,
        write: () => admin.write('PUT', primaryPath + '/roles', { expected_version: primary.version, reason: '临时值班',
          roles: primary.roles.map(g => g.role === 'tech_admin' ? { ...g, expires_at } : g) }) },
      { client: owner, path: target, password: ownerPassword, write: () => owner.write('PATCH', studentPath, status) },
    ]);
    if (results[0].status === 200) {
      assert.equal((await admin.write('PUT', primaryPath + '/roles', { expected_version: primary.version + 1, roles: primary.roles, reason: '恢复轮值' })).status, 200);
    } else {
      assert.equal((await owner.request('/me')).status, 401);
      assert.equal((await admin.write('PATCH', studentPath, { expected_version: status.expected_version + 1,
        status: 'active', pilot_scope_verified: true, reason: '重新核对试点名单' })).status, 200);
      await owner.signIn(me.username, ownerPassword);
    }
    assert.equal((await admin.write('PUT', target + '/roles', { expected_version: grant.data.version,
      roles: original.roles, reason: '结束轮值' })).status, 200);
  });

  await t.test('老师核验后重置普通负责人凭证，旧密码和全部会话作废', async () => {
    const second = browser(base), admin = browser(base);
    await admin.signIn('demo.admin', adminPassword);
    const id = (await owner.request('/me')).data.account_id;
    const path = '/admin/accounts/' + id;
    const opened = (await teacher.request(path)).data;
    const newPassword = 'T1' + randomUUID();
    assert.equal((await owner.request('/auth/change-password', { method: 'POST',
      body: { current_password: ownerPassword, new_password: newPassword } })).status, 200);
    const stale = await teacher.write('POST', path + '/password-reset', {
      expected_version: opened.version, reason: '改密前打开的重置表单',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, 'version_conflict');
    await second.signIn('0000000002', newPassword);
    await owner.request('/auth/csrf');
    const before = (await teacher.request(path)).data;
    assert.equal(before.version, opened.version + 1);
    const body = { expected_version: before.version, reason: '本人申请找回凭证' };
    const reset = (actor, data, key) => actor.write('POST', path + '/password-reset', data, key);
    assert.equal((await reset(owner, body)).status, 403);
    assert.equal((await reset(teacher, { ...body, reason: ' ' })).status, 422);
    const key = randomUUID();
    const results = await Promise.all([reset(teacher, body, key), reset(teacher, body, key)]);
    assert.equal(results[0].status, 200);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0].data, { completed: true, resource_id: id, version: before.version + 1 });
    assert.deepEqual((await teacher.request(path)).data, { ...before, credential_pending: true, version: before.version + 1 });
    assert.equal((await owner.request('/me')).status, 401);
    assert.equal((await second.request('/me')).status, 401);
    await second.request('/auth/csrf');
    for (const secret of [newPassword, '000002'])
      assert.equal((await second.request('/auth/login', { method: 'POST', body: { username: '0000000002', password: secret } })).status, 401);
    const events = await db.auditEvent.findMany({ where: { resource_id: id, action: 'reset_password' } });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, body.reason);
    assert.equal(events[0].actor_id, (await teacher.request('/me')).data.account_id);
    assert.deepEqual(events[0].before, { version: before.version, credential_pending: false });
    assert.deepEqual(events[0].after, { version: before.version + 1, credential_pending: true });
    await db.roleGrant.create({ data: { account_id: id, role: 'reviewer', expires_at: new Date(0) } });
    assert.equal((await reset(teacher, body, key)).status, 403);
    const teacherId = (await teacher.request('/me')).data.account_id;
    const staffPath = '/admin/accounts/' + teacherId;
    const staffBody = { expected_version: (await admin.request(staffPath)).data.version, reason: '老师本人申请' };
    assert.equal((await teacher.write('POST', staffPath + '/password-reset', staffBody)).status, 403);
    assert.equal((await admin.write('POST', staffPath + '/password-reset', staffBody)).status, 200);
    assert.equal((await teacher.request('/me')).status, 401);
  });
  await t.test('重置与停用并发仍保留一个可用永久管理员', async () => {
    const primary = browser(base), backup = browser(base);
    await primary.signIn('demo.admin', adminPassword);
    await backup.signIn('demo.dual', staffPassword);
    const id = (await primary.request('/me')).data.account_id;
    const otherId = (await backup.request('/me')).data.account_id;
    const path = '/admin/accounts/' + id, otherPath = '/admin/accounts/' + otherId;
    const body = { expected_version: (await primary.request(path)).data.version, reason: '核对管理员凭证' };
    assert.equal((await primary.write('POST', path + '/password-reset', body)).code, 'invalid_state');
    assert.equal((await primary.request('/me')).status, 200);
    await db.roleGrant.update({ where: { account_id_role: { account_id: otherId, role: 'tech_admin' } }, data: { expires_at: null } });
    const change = { status: 'inactive', expected_version: (await backup.request(otherPath)).data.version, reason: '管理员轮岗' };
    const results = await raceAdminChanges(base, [
      { client: primary, path, password: adminPassword, write: () => primary.write('POST', path + '/password-reset', body) },
      { client: backup, path: otherPath, password: staffPassword, write: () => backup.write('PATCH', otherPath, change) },
    ]);
    const changed = results[0].status === 200 ? primary : backup;
    assert.equal((await changed.request('/me')).status, 401);
  });
}));
