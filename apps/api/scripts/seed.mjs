import { Database } from '../dist/database.js';
import { hashPassword } from '../dist/auth/password.js';

const staffPassword=process.env.DEMO_STAFF_PASSWORD;
if(!staffPassword || staffPassword.length<12) throw Error('请设置至少 12 字符的 DEMO_STAFF_PASSWORD');
const db=new Database();
const people=[
  ['0000000001','体验学生',['student']],['0000000002','甲负责人',['student','organizer']],
  ['0000000003','乙负责人',['student','organizer']],['0000000004','活动协作者',['student','organizer']],
  ['demo.teacher','独立审核员',['reviewer']],['demo.dual','兼任审核员',['reviewer','organizer']],
];
try {
 await db.$transaction(async tx=>{
  const ids=[];
  for(const [username,display_name,roles] of people) {
    const student=roles.includes('student');
    const a=await tx.account.upsert({where:{username},update:{},create:{username,display_name,
      password_hash:await hashPassword(student?username.slice(-6):staffPassword),must_change_password:student,
      roles:{create:roles.map(role=>({role}))},...(student && {student:{create:{student_no:username}}})}});
    ids.push(a.id);
  }
  for(const [i,code] of ['P2026-0001','P2026-0002'].entries()) {
    const start=Date.now()+7*86400000;
    const iso=t=>new Date(t).toISOString();
    const content={title:i?'校园服务乙':'校园服务甲',description:'整理服务资料',beneficiaries:'在校师生',campus:'沙河',location:'活动室 A',
      meeting_point:'大厅',transport_notes:'步行',capacity:30,registration_opens_at:iso(Date.now()-86400000),registration_closes_at:iso(start-86400000),
      result_expected_at:iso(start-3600000),schedule:{schedule_type:'continuous',starts_at:iso(start),ends_at:iso(start+7200000)},
      eligibility_text:'本院学生',selection_text:'人工录取',hours_rule_text:'按核定记录',hours_import_expected_at:iso(start+86400000),
      contact_text:'志协办公室',group_join_instructions:'录取后向负责人领取群号'};
    const owner=ids[i+1], members=[{account_id:owner,member_role:'owner'}];
    if(!i) for(const account_id of [ids[3],ids[5]]) members.push({account_id,member_role:'collaborator'});
    await tx.activity.upsert({where:{activity_code:code},update:{},create:{activity_code:code,status:i?'pending_review':'published',
      working_revision:1,published_revision:i?null:1,members:{create:members},revisions:{create:{revision:1,
      revision_state:i?'pending_review':'approved',content,created_by:owner,...(!i && {approved_at:new Date()})}}}});
  }
  const pending=await tx.activity.findUniqueOrThrow({where:{activity_code:'P2026-0002'}});
  if(pending.status==='pending_review') await tx.activityReview.upsert({
    where:{activity_id_revision:{activity_id:pending.id,revision:pending.working_revision}},update:{},
    create:{activity_id:pending.id,revision:pending.working_revision,submitted_by:ids[2]}});
  const student=await tx.student.findUniqueOrThrow({where:{student_no:'0000000004'}});
  const activity=await tx.activity.findUniqueOrThrow({where:{activity_code:'P2026-0001'}});
  const relation={student_id:student.id,activity_id:activity.id};
  await tx.registration.upsert({where:{activity_id_student_id:relation},update:{},create:{...relation,status:'accepted'}});
 },{timeout:30000});
 console.log('合成账号及两项活动已就绪。已有记录保留。');
} finally {await db.$disconnect()}
