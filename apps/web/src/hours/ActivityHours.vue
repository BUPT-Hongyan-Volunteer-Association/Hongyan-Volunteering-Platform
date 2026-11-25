<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, createCommand, requestHourVoid, type HourRecord } from '@hongyan/contracts';
import HourLedger from '@hongyan/ui/HourLedger.vue';
import { message, noAccess } from '@hongyan/ui/usePageRead';
const props = defineProps<{ writesPaused?: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(), router = useRouter();
const id = String(route.params.id), base = '/managed/' + id;
const scope = { type: 'activity_hours', activity_id: id } as const;
const ledger = ref<InstanceType<typeof HourLedger>>();
const record = ref<HourRecord>(), reason = ref(''), sending = ref(false), error = ref('');
const command = createCommand();
watch(record, () => { error.value = ''; reason.value = ''; command.confirmed(); });
watch(() => route.fullPath, () => { record.value = undefined; });
onScopeDispose(() => { record.value = undefined; });
function denied() { record.value = undefined; emit('denied'); }
async function submit() {
  const row = record.value;
  if (!row || props.writesPaused || sending.value || !reason.value.trim()) return;
  sending.value = true; error.value = '';
  const payload = { expected_version: row.version, reason: reason.value.trim() };
  try {
    const { data } = await requestHourVoid({ path: { id: row.id }, body: payload,
      headers: command.headers('request_hour_void', row.id, payload), throwOnError: true });
    if (record.value !== row) return;
    command.confirmed();
    await router.push({ path: base + '/batches/' + data.data.id, query: route.query.page ? { page: route.query.page } : {} });
  } catch (cause) {
    if (record.value !== row) return;
    error.value = message(cause);
    if (noAccess(cause)) { ledger.value?.clear(); denied(); }
    else if (cause instanceof ApiError && cause.status === 409) {
      command.confirmed();
      const note = error.value;
      record.value = undefined;
      await ledger.value?.refresh();
      error.value = note;
    }
  } finally { sending.value = false; }
}
</script>
<template>
  <HourLedger class="activity-ledger" ref="ledger" :scope="scope" title="时长台账"
    :batch-base="base + '/batches'" :group-base="base + '/corrections'" @denied="denied">
    <template #links>
      <div class="page-actions ledger-tools">
        <RouterLink class="button" :to="{ path: base + '/appeals', query: { page: route.query.page } }">漏记反馈</RouterLink>
        <RouterLink class="button" :to="{ path: base + '/corrections', query: { page: route.query.page } }">错帐修复</RouterLink>
      </div>
    </template>
    <template #actions="{ row }">
      <details v-if="row.status === 'current'"><summary>处理</summary><div class="page-actions">
        <button :disabled="writesPaused || sending" @click="record = row">申请撤销</button>
        <RouterLink class="button" :to="{ path: base + '/corrections', query: { new: '1', source_date: row.service_date, source_record: row.id } }">申请错帐修复</RouterLink>
      </div></details>
    </template>
  </HourLedger>
  <p v-if="error" role="alert">{{ error }}</p>
  <form v-if="record" class="void-form" @submit.prevent="submit">
    <h2>申请撤销整笔</h2>
    <p>{{ record.student_name }} · {{ record.service_date }} · {{ record.credited_hours }} 小时</p>
    <label>撤销原因<textarea v-model="reason" rows="2" maxlength="2000" required :disabled="sending" /></label>
    <div class="page-actions">
      <button type="submit" class="primary" :disabled="writesPaused || sending || !reason.trim()">提交撤销申请</button>
      <button type="button" :disabled="sending" @click="record = undefined">取消</button>
    </div>
  </form>
</template>
<style scoped>
.ledger-tools { margin-top: 16px; gap: 12px; }
.activity-ledger :deep(.hour-filters) { margin-block: 28px 24px; gap: 16px 20px; }
.activity-ledger :deep(.hour-filters > div) { display: grid; gap: 6px; }
.activity-ledger :deep(.ledger-summary) { padding: 16px 20px; gap: 12px 20px; margin-bottom: 24px; }
.activity-ledger :deep(.ledger-summary > :last-child) { margin-inline-start: auto; }
@media (max-width: 700px) {
  .activity-ledger :deep(.hour-filters) { margin-block: 24px 20px; gap: 12px; }
  .activity-ledger :deep(.ledger-summary > :last-child) { margin-inline-start: 0; }
}
.void-form { margin-block: 16px; padding: 12px; border: 1px solid var(--line); }
.void-form label { display: grid; gap: 6px; }
</style>
