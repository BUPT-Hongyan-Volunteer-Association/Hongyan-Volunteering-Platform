<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError, createCommand, listActivityIncidents, listIncidentsForReview, listMyIncidents, reviewIncident, revokeIncident,
  type Incident,
} from '@hongyan/contracts';
import StatusFilter from './StatusFilter.vue';
import Pager from './Pager.vue';
import { beijing } from './hourDisplay';
import { message, noAccess, usePageRead } from './usePageRead';

const props = defineProps<{ mode: 'self' | 'organizer' | 'admin' }>();
const emit = defineEmits<{ denied: [] }>();
const router = useRouter(), route = useRoute(), page = ref(1), size = 15;
const studentId = computed(() => typeof route.query.student_id === 'string' ? route.query.student_id : undefined);
const labels: Record<Incident['status'], string> = { pending: '待核实', confirmed: '已确认', revoked: '已撤销', rejected: '不成立' };
const status = computed(() => {
  const value = route.query.status;
  return props.mode === 'admin' && typeof value === 'string' && Object.hasOwn(labels, value)
    ? value as Incident['status'] : 'all';
});
const { data, loading, error, refresh } = usePageRead(
  () => [props.mode, route.params.id, studentId.value, page.value, status.value], async (signal) => {
    const query = { page: page.value, page_size: size };
    const options = { query, signal, throwOnError: true as const };
    if (props.mode === 'self') return (await listMyIncidents(options)).data.data;
    if (props.mode === 'organizer') return (await listActivityIncidents({ ...options, path: { id: String(route.params.id) } })).data.data;
    return (await listIncidentsForReview({ ...options, query: { ...query, student_id: studentId.value,
      status: status.value === 'all' ? undefined : status.value } })).data.data;
  }, () => emit('denied'),
);
watch([status, studentId], () => { page.value = 1; });
const selected = ref<Incident>(), reason = ref(''), result = ref(''), problem = ref(''), busy = ref(false);
const command = createCommand();
watch(selected, () => { reason.value = ''; problem.value = ''; command.confirmed(); });
async function decide(kind: 'confirmed' | 'rejected' | 'revoked') {
  const row = selected.value;
  if (!row || busy.value || !reason.value.trim()) return;
  busy.value = true; problem.value = ''; result.value = '';
  try {
    const path = { id: row.id };
    const fields = { expected_version: row.version, reason: reason.value.trim() };
    if (kind === 'revoked') {
      await revokeIncident({ path, body: fields, headers: command.headers('revoke_incident', row.id, fields), throwOnError: true });
    } else {
      const body = { ...fields, decision: kind };
      await reviewIncident({ path, body, headers: command.headers('review_incident', row.id, body), throwOnError: true });
    }
    command.confirmed(); selected.value = undefined;
    result.value = '异常记录' + labels[kind];
    await refresh();
  } catch (error) {
    if (noAccess(error) || error instanceof ApiError && error.status === 409) {
      selected.value = undefined;
      await refresh();
    }
    problem.value = message(error);
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="incident-list" :class="{ embedded: mode !== 'admin' }">
    <h1 v-if="mode === 'admin'">异常记录</h1>
    <h2 v-else>{{ mode === 'self' ? '本人异常记录' : '异常记录' }}</h2>
    <StatusFilter v-if="mode === 'admin'" label="异常状态" :model-value="status" :options="{ all: '全部', ...labels }"
      @update:model-value="router.push({ query: { ...route.query, status: $event === 'all' ? undefined : $event } })" />
    <p v-if="result" role="status">{{ result }}</p>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重读异常记录</button></p>
    <p v-else-if="loading" role="status">正在读取异常记录…</p>
    <p v-else-if="!data?.total">没有异常记录</p>
    <ul v-else class="incident-rows">
      <li v-for="row in data.items" :key="row.id">
        <div class="page-title"><strong>{{ row.occurred_at ? beijing(row.occurred_at) : row.service_date }}</strong><span class="state-chip">{{ labels[row.status] }}</span></div>
        <p>{{ row.facts }}</p>
        <p v-if="row.review_reason">核实意见：{{ row.review_reason }}</p>
        <div class="page-actions">
          <RouterLink class="button" v-if="mode === 'self' && row.status === 'confirmed'" :to="{ path: '/mine/feedback', query: { target: row.id, kind: 'incident' } }">反馈这条异常</RouterLink>
          <RouterLink class="button" v-if="mode === 'admin' && row.source_batch_id" :to="'/hours/' + row.source_batch_id">查看来源批次</RouterLink>
          <button v-if="mode === 'admin' && ['pending', 'confirmed'].includes(row.status)" :disabled="busy" @click="selected = row">
            {{ row.status === 'pending' ? '核实异常' : '处理撤销' }}
          </button>
        </div>
        <fieldset v-if="selected?.id === row.id" :disabled="busy">
          <legend>{{ row.status === 'pending' ? '核实意见' : '撤销已确认异常' }}</legend>
          <textarea v-model="reason" aria-label="异常处理原因" rows="2" maxlength="2000" />
          <div class="page-actions">
            <button v-if="row.status === 'pending'" class="primary" :disabled="!reason.trim()" @click="decide('confirmed')">确认属实</button>
            <button v-if="row.status === 'pending'" :disabled="!reason.trim()" @click="decide('rejected')">判定不成立</button>
            <button v-if="row.status === 'confirmed'" class="primary" :disabled="!reason.trim()" @click="decide('revoked')">确认撤销异常</button>
            <button @click="selected = undefined">取消</button>
          </div>
        </fieldset>
      </li>
    </ul>
    <p v-if="problem" role="alert">{{ problem }}</p>
    <Pager v-if="data && data.total > data.page_size" :page="page" :size="data.page_size" :total="data.total" @change="page = $event" />
  </section>
</template>
<style scoped>
.incident-list { overflow-wrap: anywhere; }
.incident-list.embedded { margin-block: 22px; }
.incident-rows { list-style: none; padding: 0; }
.incident-rows li { padding: 12px 0; border-block-start: 1px solid var(--line); }
.incident-rows fieldset { min-width: 0; border: 1px solid var(--line); padding: 12px; }
.incident-rows textarea { width: 100%; }
.incident-rows p { white-space: pre-wrap; }
</style>
