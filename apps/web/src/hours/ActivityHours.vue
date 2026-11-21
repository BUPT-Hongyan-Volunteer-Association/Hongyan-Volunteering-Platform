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
  <HourLedger ref="ledger" :scope="{ type: 'activity_hours', activity_id: id }" title="时长台账"
    :batch-base="base + '/batches'" :group-base="base + '/corrections'" @denied="denied">
    <template #links>
      <div class="page-actions">
        <RouterLink :to="base + '/batches'">时长批次</RouterLink>
        <RouterLink :to="base + '/corrections'">错账修复组</RouterLink>
      </div>
    </template>
    <template #actions="{ row }">
      <div v-if="row.status === 'current'" class="page-actions">
        <button :disabled="writesPaused || sending" @click="record = row">申请撤销</button>
        <RouterLink :to="{ path: base + '/corrections', query: { new: '1', source_date: row.service_date, source_record: row.id } }">错账修复</RouterLink>
      </div>
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
.void-form { margin-block: 16px; padding: 12px; border: 1px solid var(--line); }
.void-form label { display: grid; gap: 6px; }
</style>
