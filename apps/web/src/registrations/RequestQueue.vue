<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import {
  ApiError, createCommand, createExitRequest, createRestorationRequest, listMyExitRequests,
  listMyRestorationRequests, withdrawRegistration, withdrawExitRequest, withdrawRestorationRequest,
  type ExitRequest, type Registration,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { message, noAccess, usePageRead } from '@hongyan/ui/usePageRead';
import { requestKinds, requestStates, type RequestKind } from './labels';

const props = defineProps<{ registration: Registration; writesPaused?: boolean }>();
const emit = defineEmits<{ changed: [message: string] }>();
const kind = ref<RequestKind>(props.registration.status === 'exited' ? 'restoration' : 'exit');
const page = ref(1), reason = ref(''), error = ref(''), busy = ref(false), conflict = ref(false);
const exit = computed(() => kind.value === 'exit');
const canApply = computed(() => exit.value ? props.registration.can_request_exit : props.registration.can_request_restoration);
const command = createCommand();
let mounted = true;
onScopeDispose(() => { mounted = false; });
watch(() => props.registration.status, state => { if (state === 'exited') kind.value = 'restoration'; });
watch(kind, () => { page.value = 1; reason.value = ''; error.value = ''; }, { flush: 'sync' });
const { data: queue, loading, error: readError, refresh: reload, clear } = usePageRead(
  () => [kind.value, page.value, props.registration],
  async signal => (await (exit.value ? listMyExitRequests : listMyRestorationRequests)({
    query: { activity_id: props.registration.activity_id, page: page.value, page_size: 10 },
    signal, throwOnError: true,
  })).data.data,
);
watch(queue, result => {
  if (!result) return;
  page.value = Math.min(page.value, Math.max(1, Math.ceil(result.total / result.page_size)));
  conflict.value = false;
});
const paused = computed(() => props.writesPaused || loading.value || busy.value || conflict.value || !queue.value);
async function act(action: 'create' | 'withdraw' | 'withdrawRegistration', row?: ExitRequest) {
  if (paused.value) return;
  const registration = props.registration, type = kind.value;
  const id = row?.id ?? registration.id;
  busy.value = true;
  error.value = '';
  try {
    if (action === 'create') {
      const body = { registration_id: id, expected_registration_version: registration.version, reason: reason.value.trim() };
      await (exit.value ? createExitRequest : createRestorationRequest)({
        body, headers: command.headers(type, id, body), throwOnError: true,
      });
    } else {
      const body = { expected_version: row?.version ?? registration.version };
      const write = row ? (exit.value ? withdrawExitRequest : withdrawRestorationRequest) : withdrawRegistration;
      await write({ path: { id }, body, headers: command.headers(action, id, body), throwOnError: true });
    }
    command.confirmed();
    if (!mounted || registration.id !== props.registration.id) return;
    reason.value = '';
    emit('changed', action === 'withdrawRegistration' ? '已撤回报名。' :
      requestKinds[type] + (action === 'create' ? '已提交。' : '已撤回。'));
  } catch (e) {
    if (!mounted || registration.id !== props.registration.id) return;
    error.value = message(e);
    conflict.value = noAccess(e) || (e instanceof ApiError && e.status === 409);
    if (conflict.value) clear();
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="my-requests">
    <h2>退出与恢复</h2>
    <div class="request-tabs" role="group" aria-label="申请类型">
      <button v-for="(name, k) in requestKinds" :key="k" :aria-pressed="kind === k" :disabled="busy" @click="kind = k">{{ name }}</button>
    </div>
    <p v-if="error" role="alert">{{ error }} <button v-if="conflict" @click="emit('changed', '')">刷新复核</button></p>
    <p v-if="readError" role="alert">{{ readError }} <button @click="reload()">重新读取申请</button></p>
    <p v-else-if="loading" role="status">正在读取申请…</p>
    <template v-else-if="queue">
      <button v-if="registration.can_withdraw" :disabled="paused" @click="act('withdrawRegistration')">撤回报名</button>
      <form v-if="canApply" @submit.prevent="act('create')">
        <p>{{ exit ? '退出申请待处理时仍保留名额，批准后释放。' : '恢复申请待处理时不占名额，批准后恢复原报名。' }}</p>
        <label>申请原因<textarea v-model="reason" rows="3" required maxlength="2000" /></label>
        <button class="primary" :disabled="paused || !reason.trim()">申请{{ exit ? '退出整项活动' : '恢复报名' }}</button>
      </form>
      <p v-if="!queue.items.length" class="empty">暂无符合条件的{{ requestKinds[kind] }}。</p>
      <article v-for="row in queue.items" :key="row.id">
        <div class="page-title"><strong>{{ requestKinds[kind] }}</strong><span class="state-chip">{{ requestStates[row.status] }}</span></div>
        <p>{{ row.reason }}</p><small v-if="row.created_at">{{ localDateTime(row.created_at) }}</small>
        <p v-if="row.decision_reason">处理说明 · {{ row.decision_reason }}</p>
        <div v-if="row.status === 'pending'" class="page-actions"><button :disabled="paused" @click="act('withdraw', row)">撤回{{ requestKinds[kind] }}</button></div>
      </article>
      <Pager v-if="queue.total > queue.page_size" :page="page" :total="queue.total" :size="queue.page_size" @change="page = $event" />
    </template>
  </section>
</template>
<style scoped>
.my-requests { margin-top: 24px; max-width: 40rem; overflow-wrap: anywhere; }
.request-tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.request-tabs button { border: none; border-radius: 0; padding-inline: 2px; color: var(--muted); }
.request-tabs button[aria-pressed='true'] { color: var(--brand); box-shadow: inset 0 -3px var(--brand); font-weight: 650; }
form label { display: grid; gap: 6px; margin-block: 12px; font-weight: 600; }
textarea { width: 100%; }
.empty, small { color: var(--muted); }
article { border-bottom: 1px solid var(--line); padding-block: 12px; }
article p { white-space: pre-wrap; }
article .page-actions { margin-top: 8px; }
</style>
