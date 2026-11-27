<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError, createCommand, decideExitRequest, decideRestorationRequest,
  listExitRequests, listActivityRestorationRequests, type ExitRequest,
} from '@hongyan/contracts';
import RecordWorkspace from '@hongyan/ui/RecordWorkspace.vue';
import Pager from '@hongyan/ui/Pager.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { message, noAccess, pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import { requestStates, requestKinds, type RequestKind } from './labels';

const props = defineProps<{ activityId: string; requestId?: string; writesPaused?: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(), router = useRouter();
const base = computed(() => '/managed/' + props.activityId + '/requests');
const explicitKind = computed(() => Object.hasOwn(requestKinds, String(route.query.kind)) ? route.query.kind as RequestKind : undefined);
const status = computed(() => {
  const value = String(route.query.status ?? 'pending');
  return value === 'all' || Object.hasOwn(requestStates, value) ? value : 'pending';
});
const options = [{ value: 'all', label: '全部状态' }, ...Object.entries(requestStates).map(([value,label]) => ({value,label}))];
const page = computed(() => pageNumber(route.query.request_page));
async function read(kind: RequestKind, signal: AbortSignal, query: { request_id?: string; status?: ExitRequest['status']; page?: number; page_size?: number }) {
  const list = kind === 'exit' ? listExitRequests : listActivityRestorationRequests;
  return (await list({ path: { id: props.activityId }, query: { ...query, scope: 'managed' }, signal, throwOnError: true })).data.data;
}
const { data: detail, loading: detailLoading, error: detailError, refresh: reloadDetail, clear: clearDetail } = usePageRead(
  () => [props.activityId, props.requestId, explicitKind.value],
  async signal => {
    if (!props.requestId) return;
    // 旧链接只有申请 ID。两类申请共用 ID 空间，按当前活动权限查找。
    for (const kind of explicitKind.value ? [explicitKind.value] : ['exit','restoration'] as const) {
      const row = (await read(kind, signal, { request_id: props.requestId })).items[0];
      if (row) return { kind, row };
    }
    throw new Error('申请不存在或不可见');
  }, denied,
);
const resolvedKind = computed(() => explicitKind.value ?? detail.value?.kind ?? (props.requestId ? undefined : 'exit'));
const kind = computed<RequestKind>(() => resolvedKind.value ?? 'exit');
const listQuery = computed(() => ({ ...route.query, kind: resolvedKind.value }));
const { data: queue, loading, error: listError, refresh: reloadList, clear: clearList } = usePageRead(
  () => [props.activityId, resolvedKind.value, status.value, page.value],
  async signal => resolvedKind.value && read(resolvedKind.value, signal, { page: page.value, page_size: 10,
    status: Object.hasOwn(requestStates, status.value) ? status.value as ExitRequest['status'] : undefined }),
  denied,
);
watch(queue, result => {
  if (!result) return;
  const last = Math.max(1, Math.ceil(result.total / result.page_size));
  if (page.value > last) void router.replace({ path: route.path, query: { ...listQuery.value, request_page: String(last) } });
});
function setStatus(value: string) {
  void router.push({ path: base.value, query: { ...listQuery.value, status: value, request_page: undefined } });
}
const reason = ref(''), feedback = ref(''), problem = ref(''), busy = ref(false), conflict = ref(false);
const heading = ref<HTMLElement>();
watch(() => detail.value?.row.id, async id => {
  if (!id) return;
  await nextTick();
  heading.value?.focus({ preventScroll: true });
  if (window.matchMedia('(max-width: 1023px)').matches) heading.value?.scrollIntoView({ block: 'start' });
});
const command = createCommand();
let mounted = true, viewVersion = 0;
let accessVersion = 0;
onScopeDispose(() => { mounted = false; });
const backgroundError = ref('');
function denied() {
  accessVersion++;
  clearDetail();
  clearList();
  reason.value = '';
  feedback.value = '';
  problem.value = '';
  backgroundError.value = '';
  conflict.value = false;
  emit('denied');
}
watch(() => props.requestId, () => {
  viewVersion++;
  reason.value = ''; feedback.value = ''; problem.value = ''; backgroundError.value = ''; conflict.value = false;
}, { flush: 'sync' });
async function reviewAgain() {
  const version = viewVersion;
  backgroundError.value = '';
  await Promise.all([reloadDetail(), reloadList()]);
  if (mounted && viewVersion === version && detail.value) { conflict.value = false; problem.value = ''; }
}
async function decide(decision: 'approved' | 'rejected') {
  const current = detail.value;
  if (!current || current.row.status !== 'pending' || busy.value || props.writesPaused || conflict.value) return;
  const {row, kind} = current;
  const version = viewVersion;
  const accessAtSubmit = accessVersion;
  const body = { expected_version: row.version, decision, reason: reason.value.trim() };
  busy.value = true;
  feedback.value = ''; backgroundError.value = '';
  problem.value = '';
  try {
    await (kind === 'exit' ? decideExitRequest : decideRestorationRequest)({
      path: { id: row.id }, query: { scope: 'managed' }, body,
      headers: command.headers(kind + '_decision', row.id, body), throwOnError: true,
    });
    command.confirmed();
    if (!mounted || accessAtSubmit !== accessVersion) return;
    const outcome = requestKinds[kind] + requestStates[decision];
    if (viewVersion === version) {
      feedback.value = outcome;
      reason.value = '';
      await Promise.all([reloadDetail(), reloadList()]);
    } else {
      feedback.value = row.student_name + '的' + outcome;
      await reloadList();
    }
  } catch (e) {
    if (!mounted || accessAtSubmit !== accessVersion) return;
    if (noAccess(e)) {
      denied();
      backgroundError.value = message(e);
      return;
    }
    if (viewVersion !== version) { backgroundError.value = row.student_name + '的' + requestKinds[kind] + '：' + message(e); return; }
    problem.value = message(e);
    conflict.value = e instanceof ApiError && e.status === 409;
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="request-workspace">
    <h2>退出与恢复</h2>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <p v-if="backgroundError" role="alert">{{ backgroundError }} <button @click="reviewAgain">刷新复核</button></p>
    <RecordWorkspace :selected="!!requestId">
      <template #list>
        <nav class="section-nav" aria-label="申请类型">
          <RouterLink v-for="(name, k) in requestKinds" :key="k" custom
            :to="{ path: base, query: { ...listQuery, kind: k, request_page: undefined } }" v-slot="{ href, navigate }">
            <a :href="href" :class="{ current: resolvedKind === k }" :aria-current="resolvedKind === k ? 'page' : undefined"
              @click="navigate">{{ name }}</a>
          </RouterLink>
        </nav>
        <div class="page-actions"><span>申请状态</span><UiSelect label="申请状态" :model-value="status" :options="options" @update:model-value="setStatus($event)" /></div>
        <p v-if="listError" role="alert">{{ listError }} <button @click="reviewAgain">重新读取申请</button></p>
        <p v-else-if="loading" role="status">正在读取申请…</p>
        <p v-else-if="queue && !queue.total">暂无符合条件的{{ requestKinds[kind] }}</p>
        <div v-else class="entry-list">
          <RouterLink v-for="row in queue?.items" :key="row.id" :aria-current="row.id === requestId ? 'true' : undefined"
            :aria-label="(row.status === 'pending' ? '处理申请' : '查看申请') + ' · ' + row.student_name + ' ' + row.student_no"
            :to="{ path: base + '/' + row.id, query: listQuery }">
            <div><strong>{{ row.student_name }}</strong><small>{{ row.student_no }} {{ row.item_label }}</small></div>
            <span class="state-chip" :class="{ neutral: row.status !== 'pending' }">{{ requestStates[row.status] }}</span>
          </RouterLink>
        </div>
        <Pager v-if="queue && queue.total > queue.page_size" :page="page" :size="queue.page_size" :total="queue.total"
          @change="router.push({ path: base, query: { ...listQuery, request_page: String($event) } })" />
      </template>
      <template #detail>
        <RouterLink class="back-link" :to="{path:base, query:listQuery}">返回申请列表</RouterLink>
        <p v-if="problem" role="alert">{{ problem }} <button v-if="conflict" @click="reviewAgain">刷新复核</button></p>
        <p v-if="detailError" role="alert">{{ detailError }} <button @click="reviewAgain">重新读取详情</button></p>
        <p v-else-if="detailLoading" role="status">正在读取申请详情…</p>
        <template v-else-if="detail">
          <div class="page-title"><h3 ref="heading" tabindex="-1">{{ detail.row.student_name }}的{{ requestKinds[detail.kind] }}</h3>
            <span class="state-chip">{{ requestStates[detail.row.status] }}</span></div>
          <dl class="detail-fields">
            <dt>学号</dt><dd>{{ detail.row.student_no }}</dd>
            <dt>申请时间</dt><dd>{{ detail.row.created_at && localDateTime(detail.row.created_at) }}</dd>
            <template v-if="detail.row.item_label"><dt>报名项目</dt><dd>{{ detail.row.item_label }}</dd></template>
            <dt>申请原因</dt><dd>{{ detail.row.reason }}</dd>
            <template v-if="detail.row.decision_reason"><dt>处理说明</dt><dd>{{ detail.row.decision_reason }}</dd></template>
          </dl>
          <form v-if="detail.row.status === 'pending'" @submit.prevent="decide('approved')">
            <p>{{ detail.kind === 'exit' ? '批准后释放该生名额' : '批准时重新核对余量，成功后占用一个名额' }}</p>
            <label>处理说明（驳回必填）<textarea v-model="reason" maxlength="2000" rows="2" /></label>
            <div class="page-actions">
              <button class="primary" :disabled="busy || writesPaused || conflict">批准{{ detail.kind === 'exit' ? '退出' : '恢复' }}</button>
              <button type="button" :disabled="busy || writesPaused || conflict || !reason.trim()" @click="decide('rejected')">驳回{{ detail.kind === 'exit' ? '退出' : '恢复' }}</button>
            </div>
          </form>
        </template>
      </template>
    </RecordWorkspace>
  </section>
</template>
<style scoped>
.request-workspace { overflow-wrap: anywhere; }
.request-workspace > h2 { margin-bottom: 18px; }
.section-nav { margin-top: 0; margin-bottom: 12px; }
.entry-list { margin-top: 16px; }
.entry-list small { display: block; margin-top: 3px; color: var(--muted); }
.entry-list .state-chip { margin-inline-start: auto; }
.page-title h3 { margin: 0; }
.detail-fields dd { white-space: pre-wrap; }
form { max-width: 40rem; }
form label { display: grid; gap: 6px; margin-block: 12px; font-weight: 600; }
textarea { width: 100%; }
</style>
