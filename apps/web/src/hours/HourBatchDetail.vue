<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, createCommand, downloadEvidence, getHourBatch, getHourImportErrorReport, retryHourBatchValidation, submitHourBatch } from '@hongyan/contracts';
import HourRows from './HourRows.vue';
import HourUpload from './HourUpload.vue';
import { beijing, message, modes, noAccess, signed, statuses, useHourRead } from '@hongyan/ui/hourDisplay';

const props = defineProps<{ writesPaused:boolean }>();
const emit = defineEmits<{ denied:[] }>();
const rows = ref<InstanceType<typeof HourRows>>();
const route = useRoute(), activityId = String(route.params.id), id = String(route.params.item);
const retryCommand = createCommand(), busy = ref(false), feedback = ref(''), problem = ref(''), replacing = ref(false);
const submitCommand = createCommand();
let alive = true;
onScopeDispose(() => { alive = false; });
const {data:batch,error,loading,refresh} = useHourRead(() => id, async (signal) => {
  const result = (await getHourBatch({path:{id},signal,throwOnError:true})).data.data;
  if (result.activity_id !== activityId) throw new Error('该批次不属于当前活动。');
  return result;
}, () => emit('denied'));
const canReplace = computed(() => batch.value?.mode !== 'void' &&
  ['invalid', 'rejected', 'ready'].includes(batch.value?.status ?? ''));
watch(batch,(current,_,cleanup) => {
  if (current?.status !== 'validating') return;
  const timer = window.setTimeout(() => void refresh(false),1000);
  cleanup(() => clearTimeout(timer));
});
async function submit() {
  const current = batch.value;
  if (props.writesPaused || busy.value || current?.status !== 'ready' || !current.source_hash || !current.valid_count) return;
  const body = { expected_version: current.version, source_hash: current.source_hash };
  busy.value = true; problem.value = ''; feedback.value = '';
  try {
    const { data } = await submitHourBatch({ path: { id }, body,
      headers: submitCommand.headers('submit_hour_batch', id, body), throwOnError: true });
    submitCommand.confirmed();
    if (alive) {
      batch.value = data.data;
      feedback.value = '批次已提交审核。';
    }
  } catch (reason) {
    if (!alive) return;
    problem.value = message(reason);
    if (noAccess(reason) || reason instanceof ApiError && reason.status === 409) {
      submitCommand.confirmed();
      await refresh();
    }
  } finally { if (alive) busy.value = false; }
}
async function retry() {
  if (props.writesPaused || busy.value || batch.value?.status !== 'failed') return;
  busy.value = true; feedback.value = ''; problem.value = '';
  try {
    const body = {expected_version:batch.value.version};
    const {data} = await retryHourBatchValidation({path:{id},body,headers:retryCommand.headers('retry_hour_batch_validation',id,body),throwOnError:true});
    retryCommand.confirmed();
    if (alive) { feedback.value = '已重新排队，使用原工作簿校验。'; batch.value = data.data; await refresh(false); }
  } catch (reason) { if (alive) { problem.value = message(reason); if (noAccess(reason) || reason instanceof ApiError && reason.status === 409) await refresh(); } }
  finally { if (alive) busy.value = false; }
}
async function download(report: boolean) {
  const current = batch.value;
  if (!current || busy.value || props.writesPaused) return;
  busy.value = true; problem.value = '';
  try {
    const file = report ? (await getHourImportErrorReport({path:{id},throwOnError:true})).data.data
      : { id:current.source_file_id, name:current.source_file_name };
    if (!file.id) throw new Error('没有可下载的文件。');
    const {data} = await downloadEvidence({path:{id:file.id},throwOnError:true,parseAs:'blob'});
    if (!alive) return;
    const url = URL.createObjectURL(data), anchor = document.createElement('a');
    anchor.href = url; anchor.download = file.name ?? '时长工作簿.xlsx'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  } catch (reason) { if (alive) { problem.value = message(reason); if (noAccess(reason)) await refresh(); } }
  finally { if (alive) busy.value = false; }
}
</script>
<template>
  <section class="hour-detail">
    <RouterLink class="back-link" :to="{name:'hour-batches',params:{id:activityId},query:route.query}">返回时长批次</RouterLink>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重读批次</button></p>
    <p v-else-if="!batch && loading" role="status">正在读取批次…</p>
    <template v-if="batch">
      <header><h2>{{ batch.source_file_name ?? '时长批次详情' }}</h2><span class="state-chip" role="status">{{ statuses[batch.status] }}</span></header>
      <p class="meta">{{ batch.batch_code }} · {{ beijing(batch.submitted_at ?? batch.created_at) }}（北京时间） · {{ modes[batch.mode] }}</p>
      <p v-if="batch.source_description">批次说明：{{ batch.source_description }}</p>
      <p v-if="batch.decision_reason">审核意见：{{ batch.decision_reason }}</p>
      <p v-if="batch.previous_batch_id"><RouterLink :to="{name:'hour-batch',params:{id:activityId,item:batch.previous_batch_id},query:route.query}">查看修正前批次</RouterLink></p>
      <p v-if="batch.status === 'validating'" role="status">正在校验工作簿，此页会自动更新。</p>
      <p v-if="batch.error_message" class="notice">
        {{ batch.error_message }}
        <button v-if="batch.status === 'invalid' && batch.error_count" @click="rows?.showErrors()">
          查看 {{ batch.error_count }} 行错误
        </button>
      </p>
      <div class="tools">
        <button v-if="batch.status === 'ready'" class="primary" :disabled="busy || writesPaused || !batch.valid_count" @click="submit">提交审核</button>
        <button v-if="batch.status === 'invalid'" class="primary" :disabled="busy || writesPaused" @click="download(true)">下载错误报告</button>
        <button v-if="canReplace" :disabled="busy || writesPaused" @click="replacing=!replacing">{{ replacing ? '收起上传表单' : '修正后重传' }}</button>
        <button v-if="batch.status === 'failed'" class="primary" :disabled="busy || writesPaused" @click="retry">重试原批次</button>
        <button v-if="batch.source_file_id" :disabled="busy || writesPaused" @click="download(false)">下载原工作簿</button>
      </div>
      <p v-if="batch.status === 'ready' && !batch.valid_count">本批均为重复记录，无需送审。</p>
      <p v-if="problem" role="alert">{{ problem }}</p>
      <KeepAlive v-if="canReplace">
        <HourUpload v-if="replacing" :activity-id="activityId" :previous="batch" :writes-paused="writesPaused" @denied="refresh()" />
      </KeepAlive>
      <div v-if="batch.row_count !== undefined" class="summary">
        <strong>全批预计差额：{{ signed(batch.projected_delta_hours) }} 小时</strong>
        <span>共 {{ batch.row_count }} 行 · 有效 {{ batch.valid_count }} · 跳过 {{ batch.skipped_count }} · 错误 {{ batch.error_count }}</span>
        <span>时长警告 {{ batch.warnings.length }} 条 · 违纪待核实 {{ batch.misconduct_review_required_count ?? 0 }} 行</span>
        <small v-if="batch.status === 'pending_review'">待审核，批准后生效。</small>
      </div>
      <HourRows v-if="batch.row_count" ref="rows" :batch-id="id" @denied="refresh()" />
    </template>
  </section>
</template>
<style scoped>
.hour-detail { min-width:0; }
header,.tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
h2,.meta { overflow-wrap:anywhere; }
.meta,small { color:var(--muted); }
.notice { padding:12px; background:#fff7d6; }
.summary { margin:18px 0; padding:16px; border:1px solid var(--line); display:grid; gap:6px; border-radius:6px; }
.summary strong { color:var(--brand); font-size:18px; }
.tools { margin-bottom:12px; }
</style>
