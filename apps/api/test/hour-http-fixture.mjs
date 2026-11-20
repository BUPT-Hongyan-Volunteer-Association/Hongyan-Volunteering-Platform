import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { strFromU8, unzipSync } from 'fflate';
import { validate } from '../dist/activities/validation.js';

export async function checkHourHttp(db,{activityId,bytes,fixed,ownerId,legacyWorkbook,combinedErrors,mixedKeyErrors,extraCellsWorkbook},{owner,other,student,teacher}) {
  const collection = '/organizer/activities/'+activityId+'/hour-imports';
  const before = await db.hourRecord.findMany();
  const upload = (client, data, key, fields = {}, headers = {}) => {
    const form = new FormData();
    form.set('file',new Blob([data]),'合成预览.xlsx');
    const defaults = fields.mode === 'correction' ? {} : {mode:'new',schedule_revision:'1'};
    for (const [name,value] of Object.entries({...defaults,...fields})) form.set(name,value);
    return client.raw(collection,{method:'POST',body:form,headers:{'Idempotency-Key':key,...headers}});
  };
  const result = async (response, status) => {
    const payload = await response.json();
    assert.equal(response.status,status,JSON.stringify(payload));
    return payload.data;
  };
  const settled = async (id,status) => {
    const deadline = Date.now()+20000;
    do {
      const detail = await result(await owner.raw('/hour-imports/'+id),200);
      if (detail.status !== 'validating') {
        assert.equal(detail.status,status,JSON.stringify(detail));
        validate('hour_batch',detail);
        return detail;
      }
      await delay(50);
    } while (Date.now()<deadline);
    assert.fail('批次一直停留在 validating');
  };
  const retry = (batch,key,version=batch.version) => owner.raw('/hour-imports/'+batch.id+'/retry',{method:'POST',
    headers:{'Idempotency-Key':key,'Content-Type':'application/json'},body:JSON.stringify({expected_version:version})});
  await result(await upload(student,bytes,randomUUID()),403);
  await result(await upload(other,bytes,randomUUID()),404);
  await result(await upload(owner,bytes,randomUUID(),{},{'X-CSRF-Token':'invalid'}),403);
  await result(await upload(owner,Buffer.alloc(5242881),randomUUID()),422);
  await result(await upload(owner,Buffer.alloc(5243000),randomUUID()),422);
  const key = randomUUID();
  const accepted = await result(await upload(owner,bytes,key),202);
  assert.equal(accepted.status,'validating');
  assert.equal(accepted.source_file_name,'合成预览.xlsx');
  validate('hour_batch',accepted);
  assert.deepEqual(await result(await upload(owner,bytes,key),202),accepted);
  await result(await upload(owner,fixed,key),409);
  const sourceUrl = '/files/'+accepted.source_file_id+'/download';
  assert.equal((await teacher.raw(sourceUrl)).status,200);
  const detail = await settled(accepted.id,'invalid'), path = '/hour-imports/'+detail.id;
  assert.deepEqual([detail.row_count,detail.error_count,detail.skipped_count,detail.projected_delta_hours],[4,1,1,'9.0']);
  assert.equal(detail.warnings[0].projected_daily_hours,'25.0');
  const page = await result(await owner.raw(path+'/rows?page=2&page_size=1&action=add'),200);
  assert.deepEqual([page.total,page.items[0].row_number],[2,804]);
  assert.equal((await result(await owner.raw(path+'/rows?misconduct_requires_review=true'),200)).total,1);
  assert.equal((await result(await owner.raw(path),200)).projected_delta_hours,'9.0');
  assert.equal((await result(await owner.raw(collection+'?status=invalid'),200)).total,1);
  await result(await retry(detail,randomUUID()),409);
  const report = await result(await teacher.raw(path+'/error-report'),200);
  validate('file_resource',report);
  const download = '/files/'+report.id+'/download';
  const binary = await owner.raw(download);
  assert.equal(binary.status,200);
  const xml = strFromU8(unzipSync(new Uint8Array(await binary.arrayBuffer()))['xl/worksheets/errors.xml']);
  assert.match(xml,/>202</);
  assert.match(xml,/>credited_hours</);
  assert.doesNotMatch(xml,/000000000[123]/);
  for (const target of [path,path+'/rows',path+'/error-report',download,'/files/'+detail.source_file_id+'/download']) {
    assert.equal((await other.raw(target)).status,404);
    assert.equal((await student.raw(target)).status,403);
  }
  assert.deepEqual(Buffer.from(await (await owner.raw('/files/'+detail.source_file_id+'/download')).arrayBuffer()),bytes);
  let failed;
  await db.$executeRaw`ALTER TABLE hour_record RENAME TO test_only_unavailable_hour_record`;
  try {
    const uploaded = await result(await upload(owner,fixed,randomUUID(),{previous_batch_id:detail.id}),202);
    failed = await settled(uploaded.id,'failed');
    assert.equal((await result(await owner.raw('/hour-imports/'+failed.id+'/rows'),200)).total,0);
  } finally {
    await db.$executeRaw`ALTER TABLE test_only_unavailable_hour_record RENAME TO hour_record`;
  }
  const retryKey = randomUUID();
  await result(await retry(failed,randomUUID(),failed.version-1),409);
  const replay = await Promise.all([retry(failed,retryKey),retry(failed,retryKey)]);
  assert.deepEqual(await result(replay[0],202),await result(replay[1],202));
  const ready = await settled(failed.id,'ready');
  assert.equal(ready.previous_batch_id,detail.id);
  assert.equal(ready.retry_count,1);
  assert.equal(ready.source_file_id,failed.source_file_id);
  assert.equal(ready.source_hash,failed.source_hash);
  assert.equal(ready.valid_count,3);
  assert.equal(ready.projected_delta_hours,'10.2');
  await result(await owner.raw('/hour-imports/'+ready.id+'/error-report'),404);
  await result(await retry(ready,randomUUID()),409);
  assert.equal((await result(await owner.raw(collection),200)).total,2);
  // A correction without a matching record is a row error; its reported flag remains visible.
  const correction = await result(await upload(owner,fixed,randomUUID(),{mode:'correction'}),202);
  const mixed = await settled(correction.id,'invalid');
  const flagged = await result(await owner.raw('/hour-imports/'+mixed.id+'/rows?misconduct_requires_review=true'),200);
  assert.deepEqual(flagged.items.map(row => [row.row_number,row.action]),[[804,'error']]);
  assert.equal(mixed.misconduct_review_required_count,flagged.total);
  assert.equal(mixed.projected_delta_hours,'0.0');
  const combined = await result(await upload(owner,combinedErrors(),randomUUID()),202);
  const combinedBatch = await settled(combined.id,'invalid');
  assert.deepEqual([combinedBatch.error_count,combinedBatch.misconduct_review_required_count,combinedBatch.projected_delta_hours],
    [2,1,'0.0']);
  assert.deepEqual(combinedBatch.warnings.map(warning => [warning.code,warning.row_numbers]),[['exceeds_planned_hours',[804]]]);
  const combinedPath = '/hour-imports/'+combined.id;
  const awaiting = await result(await owner.raw(combinedPath+'/rows?misconduct_requires_review=true'),200);
  assert.deepEqual(awaiting.items.map(row => [row.row_number,row.raw_values.credited_hours,row.errors[0].field]),[[202,'1.25','credited_hours']]);
  const fields = await result(await owner.raw(combinedPath+'/rows?action=error'),200);
  assert.deepEqual(fields.items[1].errors.map(issue => [issue.row,issue.field]),[[804,'misconduct_reported'],[804,'remark']]);
  const keyed = await result(await upload(owner, mixedKeyErrors(), randomUUID()), 202);
  const keyedBatch = await settled(keyed.id, 'invalid');
  assert.deepEqual([keyedBatch.valid_count, keyedBatch.skipped_count, keyedBatch.error_count,
    keyedBatch.misconduct_review_required_count, keyedBatch.projected_delta_hours], [1, 0, 3, 1, '4.0']);
  const keyedPath = '/hour-imports/' + keyed.id + '/rows';
  const validPage = await result(await owner.raw(keyedPath + '?action=add'), 200);
  assert.deepEqual(validPage.items.map(r => [r.row_number, r.delta_hours]), [[3, '4.0']]);
  const reviewPage = await result(await owner.raw(keyedPath + '?action=error&misconduct_requires_review=true'), 200);
  assert.deepEqual(reviewPage.items.map(r => [r.row_number, r.remark]), [[804, '新上报事实']]);

  const extra = await result(await upload(owner, extraCellsWorkbook(), randomUUID()), 202);
  const extraBatch = await settled(extra.id, 'invalid');
  const extraReport = await result(await owner.raw('/hour-imports/' + extra.id + '/error-report'), 200);
  const extraFile = await owner.raw('/files/' + extraReport.id + '/download');
  assert.equal(extraFile.status, 200);
  const extraXml = strFromU8(unzipSync(new Uint8Array(await extraFile.arrayBuffer()))['xl/worksheets/errors.xml']);
  assert.deepEqual([...extraXml.matchAll(/<t>([^<>]*)<\/t>/g)].slice(3).map(match => match[1]),
    ['202', 'H202', '未知列存在数据', '804', 'H804', '未知列存在数据',
      '804', 'credited_hours', '须为 0.1–999.9 的数值，最多一位小数']);
  assert.deepEqual([extraBatch.row_count, extraBatch.error_count, extraBatch.valid_count, extraBatch.projected_delta_hours],
    [3, 2, 1, '2.0']);
  const validRows = await result(await owner.raw('/hour-imports/' + extra.id + '/rows?action=add'), 200);
  assert.deepEqual(validRows.items.map(row => row.row_number), [805]);

  const bad = await result(await upload(owner,Buffer.from('工作簿损坏'),randomUUID()),202);
  const invalid = await settled(bad.id,'invalid');
  assert.match(invalid.error_message,/修正后重新上传/);
  await result(await retry(invalid,randomUUID()),409);
  const full = await result(await upload(owner,legacyWorkbook(5000),randomUUID()),202);
  const legacy = await settled(full.id,'ready');
  assert.deepEqual([legacy.template_structure,legacy.row_count,legacy.valid_count,legacy.skipped_count,legacy.projected_delta_hours],
    ['legacy_hours_6',5000,2,4998,'3.2']);
  const lastPage = await result(await owner.raw('/hour-imports/'+legacy.id+'/rows?page=50&page_size=100'),200);
  assert.equal(lastPage.total,5000);
  assert.equal(lastPage.items.length,100);
  const lastRow = lastPage.items.at(-1);
  assert.deepEqual([lastRow.row_number,lastRow.action,lastRow.misconduct_reported,lastRow.bound_schedule_revision],
    [5001,'add','not_provided',1]);
  const over = await result(await upload(owner,legacyWorkbook(5001),randomUUID()),202);
  await settled(over.id,'invalid');
  const overPath = '/hour-imports/'+over.id;
  assert.equal((await result(await owner.raw(overPath+'/rows'),200)).total,0);
  const overReport = await result(await owner.raw(overPath+'/error-report'),200);
  const overFile = await owner.raw('/files/'+overReport.id+'/download');
  assert.equal(overFile.status,200);
  const overXml = strFromU8(unzipSync(new Uint8Array(await overFile.arrayBuffer()))['xl/worksheets/errors.xml']);
  assert.match(overXml,/>5002</);
  assert.match(overXml,/超过 5000 条非空记录/);
  assert.deepEqual(await db.hourRecord.findMany(),before);
  await db.activityMember.delete({where:{activity_id_account_id:{activity_id:activityId,account_id:ownerId}}});
  assert.equal((await owner.raw(download)).status,404);
  await result(await upload(owner,bytes,key),404);
  await result(await retry(ready,retryKey),404);
}
