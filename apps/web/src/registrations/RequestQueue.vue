<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  ApiError,
  createCommand,
  createExitRequest,
  createRestorationRequest,
  decideExitRequest,
  decideRestorationRequest,
  listExitRequests,
  listActivityRestorationRequests,
  listMyExitRequests,
  listMyRestorationRequests,
  withdrawRegistration,
  withdrawExitRequest,
  withdrawRestorationRequest,
  type ExitRequest,
  type Registration,
} from '@hongyan/contracts';
import { noAccess, usePageRead } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
const props = defineProps<{
  activityId: string;
  registration?: Registration;
  requestId?: string;
  writesPaused?: boolean;
}>();
const emit = defineEmits<{ changed: [message: string] }>();
const kind = ref<'exit' | 'restoration'>(props.registration?.status === 'exited' ? 'restoration' : 'exit');
const exit = computed(() => kind.value === 'exit');
const label = computed(() => (exit.value ? '退出' : '恢复'));
const states = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已驳回',
  withdrawn: '已撤回',
  cancelled: '已取消',
};
const status = ref<ExitRequest['status'] | ''>(props.registration || props.requestId ? '' : 'pending');
const page = ref(1);
const reason = ref(''), selected = ref<ExitRequest>();
const saving = ref(false), error = ref(''), message = ref('');
const requiresRead = ref(false);
const command = createCommand();
let mounted = true;
const { data: queue, loading, error: readError, refresh: load, clear: clearQueue } = usePageRead(
  () => [kind.value, status.value, page.value, props.requestId, props.activityId, props.registration],
  async signal => {
    const query = { page: page.value, page_size: 10 };
    const { data } = props.registration
      ? await (exit.value ? listMyExitRequests : listMyRestorationRequests)({
          query: { ...query, activity_id: props.activityId }, signal, throwOnError: true,
        })
      : await (exit.value ? listExitRequests : listActivityRestorationRequests)({
          path: { id: props.activityId },
          query: { ...query, scope: 'managed', status: status.value || undefined, request_id: props.requestId },
          signal, throwOnError: true,
        });
    return data.data;
  },
);
watch(queue, result => {
  selected.value = undefined;
  if (!result) return;
  page.value = Math.min(page.value, Math.max(1, Math.ceil(result.total / result.page_size)));
  requiresRead.value = false;
});
const paused = computed(() => props.writesPaused || loading.value || saving.value || requiresRead.value || !queue.value);
watch(
  [kind, status, () => props.activityId],
  () => {
    page.value = 1;
    reason.value = '';
    error.value = '';
  },
  { flush: 'sync' },
);
watch(() => props.registration?.status, value => {
  if (value === 'exited') kind.value = 'restoration';
});
onUnmounted(() => { mounted = false; });
async function act(
  action: 'withdrawRegistration' | 'create' | 'withdraw' | 'approved' | 'rejected',
  row?: ExitRequest,
) {
  if (paused.value) return;
  const actionLabel = label.value;
  const targetActivity = props.activityId;
  const targetRequest = props.requestId;
  saving.value = true;
  error.value = '';
  const r = props.registration;
  const id = row?.id ?? r!.id;
  const text = reason.value.trim();
  try {
    if (action === 'create' && r) {
      const body = { registration_id: r.id, expected_registration_version: r.version, reason: text };
      await (exit.value ? createExitRequest : createRestorationRequest)({
        body,
        headers: command.headers(kind.value, id, body),
        throwOnError: true,
      });
    } else if (action === 'approved' || action === 'rejected') {
      const body = { expected_version: row!.version, decision: action, reason: text };
      await (exit.value ? decideExitRequest : decideRestorationRequest)({
        path: { id },
        query: { scope: 'managed' },
        body,
        headers: command.headers(action, id, body),
        throwOnError: true,
      });
    } else {
      const body = { expected_version: row?.version ?? r!.version };
      const write =
        action === 'withdrawRegistration'
          ? withdrawRegistration
          : exit.value
            ? withdrawExitRequest
            : withdrawRestorationRequest;
      await write({ path: { id }, body, headers: command.headers(action, id, body), throwOnError: true });
    }
    command.confirmed();
    if (!mounted || targetActivity !== props.activityId || targetRequest !== props.requestId) return;
    reason.value = '';
    message.value =
      action === 'withdrawRegistration'
        ? '已撤回报名。'
        : actionLabel +
          '申请' +
          { create: '已提交', withdraw: '已撤回', approved: '已批准', rejected: '已驳回' }[action] +
          '。';
    if (r) emit('changed', message.value);
    else await load();
  } catch (e) {
    if (!mounted || targetActivity !== props.activityId || targetRequest !== props.requestId) return;
    error.value = e instanceof Error ? e.message : '操作失败，请重试';
    requiresRead.value = noAccess(e) || (e instanceof ApiError && e.status === 409);
    if (requiresRead.value) clearQueue();
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <section class="reading-area">
    <h2>退出与恢复</h2>
    <div class="page-actions">
      <button
        v-for="k in ['exit', 'restoration'] as const"
        :key="k"
        :aria-pressed="kind === k"
        :disabled="saving"
        @click="kind = k"
      >
        {{ k === 'exit' ? '退出申请' : '恢复申请' }}
      </button>
      <label v-if="!registration"
        >申请状态
        <select v-model="status">
          <option value="">全部</option>
          <option v-for="(name, value) in states" :key="value" :value="value">{{ name }}</option>
        </select></label
      >
    </div>
    <p v-if="message && !registration" role="status">{{ message }}</p>
    <p v-if="error" role="alert">
      {{ error }}
      <button v-if="requiresRead" @click="registration ? emit('changed', '') : load()">刷新复核</button>
    </p>
    <p v-if="readError" role="alert">{{ readError }} <button @click="load()">重新读取申请</button></p>
    <p v-else-if="loading">正在读取申请…</p>
    <template v-else-if="queue">
      <button
        v-if="registration?.can_withdraw"
        :disabled="paused"
        @click="act('withdrawRegistration')"
      >
        撤回报名
      </button>
      <form
        v-if="registration && (exit ? registration.can_request_exit : registration.can_request_restoration)"
        @submit.prevent="act('create')"
      >
        <label>申请原因 <textarea v-model="reason" required maxlength="2000" /></label>
        <button :disabled="paused || !reason.trim()">申请{{ exit ? '退出整项活动' : '恢复报名' }}</button>
      </form>
      <p v-if="!queue.items.length">暂无符合条件的{{ label }}申请。</p>
      <article v-for="row in queue.items" :key="row.id" class="record">
        <strong
          >{{ row.student_name }} {{ row.student_no }} {{ label }}申请 · {{ states[row.status] }}</strong
        >
        <p>{{ row.reason }}</p>
        <small v-if="row.created_at">{{ localDateTime(row.created_at) }}</small>
        <p v-if="row.decision_reason">处理说明 · {{ row.decision_reason }}</p>
        <template v-if="row.status === 'pending'">
          <button v-if="registration" :disabled="paused" @click="act('withdraw', row)">
            撤回{{ label }}申请
          </button>
          <button
            v-else-if="selected?.id !== row.id"
            :disabled="paused"
            @click="
              selected = row;
              reason = '';
            "
          >
            处理申请
          </button>
          <div v-else class="page-actions">
            <label>处理说明（驳回必填）<input v-model="reason" maxlength="2000" /></label>
            <button :disabled="paused" @click="act('approved', row)">批准{{ label }}</button>
            <button :disabled="paused || !reason.trim()" @click="act('rejected', row)">
              驳回{{ label }}
            </button>
          </div>
        </template>
      </article>
      <Pager :page="page" :total="queue.total" :size="10" @change="page = $event" />
    </template>
  </section>
</template>
