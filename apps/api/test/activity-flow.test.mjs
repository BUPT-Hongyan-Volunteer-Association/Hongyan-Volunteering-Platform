import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../dist/app.js';
import { Database } from '../dist/database.js';

function browser(base) {
  let cookie = '', csrf = '';
  async function request(path, { method = 'GET', body, key } = {}) {
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    const fresh = response.headers.get('set-cookie');
    if (fresh) cookie = fresh.split(';')[0];
    const payload = await response.json();
    if (path === '/auth/csrf' && response.ok) csrf = payload.data.csrf_token;
    return { status: response.status, ...payload };
  }
  async function signIn(username, password, newPassword) {
    await request('/auth/csrf');
    assert.equal((await request('/auth/login', {method:'POST',body:{username,password}})).status,200);
    await request('/auth/csrf');
    if (newPassword) {
      assert.equal((await request('/me')).code,'password_change_required');
      assert.equal((await request('/auth/change-password',{method:'POST',body:{current_password:password,new_password:newPassword}})).status,200);
      await request('/auth/csrf');
    }
  }
  const write=(method,path,body,key=randomUUID())=>request(path,{method,body,key});
  return { request, signIn, write };
}

test('活动发布、修订、越权与旧命令在真实 PostgreSQL 上保持一致', async t => {
  // Generate the database identifier here. Only this test-owned database is dropped.
  const name = 'hy_flow_' + randomUUID().replaceAll('-','');
  const source = new URL(process.env.DATABASE_URL);
  const maintenance = new Database();
  await maintenance.$executeRawUnsafe('CREATE DATABASE '+name);
  let app;
  try {
    source.pathname = '/' + name;
    process.env.DATABASE_URL = source.href;
    const staffPassword = randomUUID();
    execFileSync('pnpm',['exec','prisma','migrate','deploy'],{stdio:'pipe'});
    execFileSync(process.execPath,['scripts/seed.mjs'],{env:{...process.env,DEMO_STAFF_PASSWORD:staffPassword}});
    app = await createApp();
    await app.listen(0,'127.0.0.1');
    const db = app.get(Database);
    const base = (await app.getUrl()) + '/api/v1';
    const [student,owner,other,teacher] = Array.from({length:4},()=>browser(base));
    await Promise.all([
      student.signIn('0000000001','000001','t1'+randomUUID()), owner.signIn('0000000002','000002','t1'+randomUUID()),
      other.signIn('0000000003','000003','t1'+randomUUID()), teacher.signIn('demo.teacher',staffPassword),
    ]);
    const sample=await db.activity.findUniqueOrThrow({where:{activity_code:'P2026-0001'},include:{revisions:true}});
    const created=await owner.write('POST','/organizer/activities',{...sample.revisions[0].content,title:'回归测试',location:'A'});
    assert.equal(created.status,201);
    const id=created.data.id,path='/organizer/activities/'+id;
    const managed=async()=>(await owner.request(path)).data;
    const version=async()=>(await managed()).activity.version;
    const publicDetail=()=>student.request('/activities/'+id);
    const edit=async fields=>owner.write('PATCH',path,{...fields,expected_version:await version()});
    const submit=async()=>{const r=await owner.write('POST',path+'/submit',{expected_version:await version()});assert.equal(r.status,201);return r.data;};
    const decide=(r,decision,reason,key)=>teacher.write('POST','/admin/activity-reviews/'+r.id+'/decision',{expected_version:r.version,decision,reason},key);

    await t.test('首次驳回与首次发布',async()=>{
      const first=await submit();
      assert.equal((await publicDetail()).status,404);
      assert.equal((await decide(first,'rejected','请修订')).status,200);
      assert.equal((await managed()).current_review.reason,'请修订');
      assert.equal((await publicDetail()).status,404);
      assert.equal((await edit({description:'已修订'})).status,200);
      assert.equal((await decide(await submit(),'approved')).status,200);
      assert.equal((await publicDetail()).data.location,'A');
    });
    const participant=await db.student.findUniqueOrThrow({where:{student_no:'0000000004'}});
    await db.registration.create({data:{activity_id:id,student_id:participant.id,status:'accepted'}});
    await t.test('待审、驳回和批准的公开可见性',async()=>{
      const old=(await publicDetail()).data.schedule_revision;
      assert.equal((await edit({location:'B'})).status,200);
      let r=await submit();
      assert(r.changes.some(c=>c.field_path==='location'&&c.before_value==='"A"'&&c.after_value==='"B"'));
      assert.equal((await publicDetail()).data.location,'A');
      assert.equal((await decide(r,'rejected','待核实')).status,200);
      assert.equal((await publicDetail()).data.schedule_revision,old);
      assert.equal((await edit({location:'B'})).status,200);
      r=await submit();
      const key=randomUUID();
      const approved=await decide(r,'approved',undefined,key);
      assert.equal(approved.status,200);
      assert.deepEqual(await decide(r,'approved',undefined,key),approved);
      const stale=await decide(r,'approved');
      assert.equal(stale.status,409);assert.equal(stale.code,'version_conflict');
      const next=(await publicDetail()).data;
      assert.equal(next.location,'B');assert.equal(next.schedule_revision,r.revision);
      assert(!Object.hasOwn(next,'group_join_instructions'));
      assert.equal(await db.activityChangeEvent.count({where:{review_id:r.id}}),1);
      assert.equal(await db.reviewAudit.count({where:{review_id:r.id}}),1);
    });
    await t.test('跨活动操作与两个旧窗口',async()=>{
      const original=await version();
      assert.equal((await other.request(path)).status,404);
      assert.equal((await other.request(path+'/members')).status,404);
      assert.equal((await other.write('PATCH',path,{expected_version:original,title:'越权'})).status,404);
      assert.equal((await other.write('POST',path+'/submit',{expected_version:original})).status,404);
      assert.equal(await version(),original);
      const saves=await Promise.all(['窗口一','窗口二'].map(title=>owner.write('PATCH',path,{expected_version:original,title})));
      assert.deepEqual(saves.map(s=>s.status).sort(),[200,409]);
      assert.equal(saves.find(s=>s.status===409).code,'version_conflict');
    });
  } finally {
    try { await app?.close(); }
    finally {
      try { await maintenance.$executeRawUnsafe('DROP DATABASE '+name); }
      finally { await maintenance.$disconnect(); }
    }
  }
});
