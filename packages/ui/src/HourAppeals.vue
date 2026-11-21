<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError, createCommand, decideAppeal, listActivityHourAppeals, listActivityHourBatches, listActivityHourCorrectionGroups,
  listAppeals, listMyAppeals, type Appeal, type AppealDecision,
} from '@hongyan/contracts';
import Pager from './Pager.vue';
import RecordWorkspace from './RecordWorkspace.vue';
import { beijing } from './hourDisplay';
import { message, noAccess, pageNumber, usePageRead } from './usePageRead';

const props = defineProps<{ mode: 'self' | 'organizer' | 'admin'; writesPaused?: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(), router = useRouter();
const id = computed(() => String(route.params.item ?? ''));
const activityId = computed(() => String(route.params.id ?? ''));
const base = computed(() => props.mode === 'self' ? '/mine/feedback' : props.mode === 'admin'
  ? '/manage/appeals' : '/managed/' + activityId.value + '/appeals');
const page = computed(() => pageNumber(route.query.appeal_page));
const statuses: Record<Appeal['status'], string> = { pending: '待受理', in_review: '处理中', resolved: '已结案', rejected: '已驳回' };
const kinds: Record<Appeal['target_type'], string> = { hours: '错账反馈', missing_hours: '漏记反馈', incident: '异常申诉', restriction: '限制申诉' };
const status = computed(() => {
  const value = String(route.query.appeal_status ?? 'all');
  return Object.hasOwn(statuses, value) ? value as Appeal['status'] : undefined;
});
const listQuery = computed(() => ({ page: route.query.page, appeal_page: route.query.appeal_page, appeal_status: route.query.appeal_status }));
async function read(signal: AbortSignal, requestedId?: string) {
  const query = requestedId ? { appeal_id: requestedId } : { page: page.value, page_size: 15, status: status.value };
  const options = { signal, query, throwOnError: true as const };
  if (props.mode === 'self') return (await listMyAppeals(options)).data.data;
  if (props.mode === 'admin') return (await listAppeals(options)).data.data;
  return (await listActivityHourAppeals({ ...options, path: { id: activityId.value } })).data.data;
}
const { data: items, error: listError, loading, refresh: loadList } = usePageRead(
  () => [props.mode, activityId.value, page.value, status.value], (signal) => read(signal), () => emit('denied'),
);
const { data: selected, error: detailError, loading: detailLoading, refresh: loadDetail, clear } = usePageRead(
  id, async (signal) => {
    if (!id.value) return;
    const result = await read(signal, id.value);
    if (!result.items[0]) throw new Error('反馈不存在或不可见。');
    return result.items[0];
  }, () => emit('denied'),
);
defineExpose({ refresh: loadList });
function setQuery(field: string, value: string) {
  void router.push({ path: route.path, query: { ...listQuery.value, ...(field === 'appeal_status' && { appeal_page: undefined }), [field]: value } });
}

const actions: Record<string, string> = {
  correct_hours: '同一笔时长已更正', void_hours: '整笔时长已撤销', rekey_hours: '错账修复组已批准',
  add_missing_hours: '漏记时长已补记', revoke_incident: '异常已正式撤销',
};
const action = ref<AppealDecision['resolution_action']>('none');
const originKind = ref<'batch' | 'group'>('batch'), originId = ref(''), originPage = ref(1);
const originSize = 20;
const reason = ref(''), problem = ref(''), result = ref(''), busy = ref(false);
const allowed = computed(() => selected.value?.target_type === 'hours' ? ['correct_hours', 'void_hours', 'rekey_hours'] as const
  : selected.value?.target_type === 'missing_hours' ? ['add_missing_hours'] as const : ['revoke_incident'] as const);
const open = computed(() => props.mode === 'admin' && !!selected.value && ['pending', 'in_review'].includes(selected.value.status));
const origin = computed(() => action.value === 'add_missing_hours' ? originKind.value
  : action.value === 'rekey_hours' ? 'group' : action.value === 'correct_hours' || action.value === 'void_hours' ? 'batch' : undefined);
const { data: origins, error: originsError, refresh: loadOrigins } = usePageRead(
  () => [selected.value?.id, origin.value, action.value, originPage.value],
  async (signal) => {
    const current = selected.value;
    if (!open.value || !current?.activity_id || !origin.value) return;
    const path = { id: current.activity_id };
    const base = { path, signal, throwOnError: true as const };
    const query = { page: originPage.value, page_size: originSize };
    if (origin.value === 'group') {
      const { data: { data } } = await listActivityHourCorrectionGroups({ ...base, query });
      return { total: data.total, items: data.items.filter((group) => group.status === 'approved' &&
        group.items.some((item) => current.target_type === 'hours' ? item.source_record.id === current.target_id
          : item.target_student_id === current.student_id && item.target_service_date === current.service_date && item.target_activity_id === current.activity_id))
        .map((group) => ({ id: group.id, text: beijing(group.reviewed_at) + ' · 修复组 ' + group.id.slice(0, 8) })) };
    }
    const mode = action.value === 'correct_hours' ? 'correction' : action.value === 'void_hours' ? 'void' : undefined;
    const { data: { data } } = await listActivityHourBatches({ ...base, query: { ...query, status: 'approved', mode } });
    return { total: data.total, items: data.items.filter((batch) => current.target_type !== 'missing_hours' || batch.mode !== 'void')
      .map((batch) => ({ id: batch.id, text: (batch.source_file_name ?? '单条撤销') + ' · ' + beijing(batch.reviewed_at) + ' · ' + batch.batch_code })) };
  },
);
watch([origin, action], () => { originId.value = ''; originPage.value = 1; });
watch(originPage, () => { originId.value = ''; });
const command = createCommand();
let live = true;
onScopeDispose(() => { live = false; });
watch(id, () => {
  action.value = 'none'; reason.value = ''; problem.value = ''; result.value = ''; busy.value = false; command.confirmed();
});
async function decide(decision: AppealDecision['decision']) {
  const current = selected.value;
  if (!current || !open.value || busy.value || !reason.value.trim()) return;
  problem.value = ''; result.value = '';
  if (decision === 'resolved' && (action.value === 'none' || (origin.value && !originId.value))) {
    problem.value = '请选择处理方式及已经批准的结果。'; return;
  }
  const body: AppealDecision = {
    expected_version: current.version, decision, reason: reason.value.trim(), resolution_action: decision === 'resolved' ? action.value : 'none',
    ...(decision === 'resolved' && origin.value === 'batch' && { correction_batch_id: originId.value }),
    ...(decision === 'resolved' && origin.value === 'group' && { correction_group_id: originId.value }),
  };
  busy.value = true;
  try {
    const { data } = await decideAppeal({ path: { id: current.id }, body,
      headers: command.headers('decide_appeal', current.id, body), throwOnError: true });
    if (!live || id.value !== current.id) return;
    command.confirmed(); selected.value = data.data; reason.value = '';
    result.value = decision === 'resolved' ? '反馈已结案，学生可查看本人的处理结果。'
      : decision === 'rejected' ? '反馈已驳回。' : '已受理反馈。';
    await loadList(false);
  } catch (error) {
    if (!live || id.value !== current.id) return;
    problem.value = message(error);
    if (noAccess(error)) { clear(); await loadList(); }
    else if (error instanceof ApiError && error.status === 409) { command.confirmed(); await loadDetail(); }
  } finally { if (live && id.value === current.id) busy.value = false; }
}
</script>
<template>
  <h1 v-if="mode !== 'self'">{{ mode === 'admin' ? '申诉与更正' : '活动时长反馈' }}</h1>
  <RecordWorkspace :selected="!!id" class="hour-appeals">
    <template #list>
      <div class="page-actions" v-if="mode !== 'self'">
        <label>反馈状态
          <select :value="status ?? 'all'" @change="setQuery('appeal_status', ($event.target as HTMLSelectElement).value)">
            <option value="all">全部</option><option v-for="(label, value) in statuses" :value="value" :key="value">{{ label }}</option>
          </select>
        </label>
      </div>
      <p v-if="listError" role="alert">{{ listError }} <button @click="loadList()">重读反馈</button></p>
      <p v-else-if="loading && !items" role="status">正在读取反馈…</p>
      <p v-else-if="!items?.total">当前没有反馈。</p>
      <div v-else class="entry-list">
        <RouterLink v-for="item in items.items" :key="item.id" :to="{ path: base + '/' + item.id, query: listQuery }"
          :class="{ selected: item.id === id }">
          <div><strong>{{ kinds[item.target_type] }} · {{ item.activity_title }}</strong>
            <small>{{ item.student_name ? item.student_name + ' · ' : '' }}{{ item.service_date }}</small>
          </div>
          <span class="state-chip">{{ statuses[item.status] }}</span>
        </RouterLink>
      </div>
      <Pager v-if="items && items.total > items.page_size" :page="page" :size="items.page_size" :total="items.total"
        @change="setQuery('appeal_page', String($event))" />
    </template>
    <template #detail>
      <RouterLink class="back-link" :to="{ path: base, query: listQuery }">返回反馈列表</RouterLink>
      <p v-if="detailError" role="alert">{{ detailError }} <button @click="loadDetail()">重读反馈详情</button></p>
      <p v-else-if="detailLoading && !selected" role="status">正在读取详情…</p>
      <template v-if="selected">
        <div class="page-title"><h2>{{ kinds[selected.target_type] }}</h2><span class="state-chip">{{ statuses[selected.status] }}</span></div>
        <dl class="detail-fields">
          <dt>活动</dt><dd>{{ selected.activity_title }}</dd>
          <dt>服务日期</dt><dd>{{ selected.service_date }}</dd>
          <template v-if="selected.student_no"><dt>申请人</dt><dd>{{ selected.student_name }} · {{ selected.student_no }}</dd></template>
          <template v-if="selected.requested_hours"><dt>申报时长</dt><dd>{{ selected.requested_hours }} 小时</dd></template>
          <dt>学生说明</dt><dd class="note">{{ selected.description }}</dd>
          <dt>提交时间</dt><dd>{{ beijing(selected.created_at) }}</dd>
          <template v-if="selected.resolution"><dt>办理结果</dt><dd class="note">{{ selected.resolution }}</dd></template>
        </dl>
        <div class="page-actions" v-if="mode === 'organizer' && ['pending', 'in_review'].includes(selected.status)">
          <RouterLink class="button" :to="'/managed/' + activityId + '/batches'">进入时长批次</RouterLink>
          <RouterLink v-if="selected.target_type === 'hours'" class="button" :to="{ path: '/managed/' + activityId + '/corrections',
            query: { new: '1', appeal_id: selected.id, source_record: selected.target_id, source_date: selected.service_date } }">新建关联修复组</RouterLink>
        </div>
        <RouterLink v-if="mode === 'self' && selected.result_hour_record_ids?.length" :to="{ path: '/mine/hours', query: {
          include_history: 'true', record: selected.result_hour_record_ids[0],
        } }">查看本人时长记录</RouterLink>
        <p v-if="result" role="status">{{ result }}</p>
        <p v-if="problem" role="alert">{{ problem }}</p>
        <fieldset v-if="open" class="appeal-decision" :disabled="busy || writesPaused">
          <legend>办理反馈</legend>
          <label>处理方式
            <select v-model="action"><option value="none">选择已完成的处理</option>
              <option v-for="choice in allowed" :key="choice" :value="choice">{{ actions[choice] }}</option>
            </select>
          </label>
          <label v-if="action === 'add_missing_hours'">结果来源
            <select v-model="originKind"><option value="batch">时长批次</option><option value="group">错账修复组</option></select>
          </label>
          <label v-if="origin">已批准的结果
            <select v-model="originId"><option value="">选择批准记录</option>
              <option v-for="item in origins?.items" :key="item.id" :value="item.id">{{ item.text }}</option>
            </select>
          </label>
          <p v-if="originsError" role="alert">{{ originsError }} <button @click="loadOrigins()">重读批准记录</button></p>
          <p v-else-if="origin && origins && !origins.items.length">本页没有符合条件的已批准结果。</p>
          <Pager v-if="origin && origins && origins.total > originSize" :page="originPage" :size="originSize" :total="origins.total" @change="originPage = $event" />
          <RouterLink v-if="action === 'revoke_incident'" :to="{ path: '/manage/incidents', query: { student_id: selected.student_id } }">进入异常复核</RouterLink>
          <label>处理意见
            <textarea v-model="reason" rows="2" maxlength="3000" placeholder="受理、驳回的说明将向学生展示" />
          </label>
          <div class="page-actions">
            <button v-if="selected.status === 'pending'" :disabled="!reason.trim()" @click="decide('in_review')">受理反馈</button>
            <button class="primary" :disabled="!reason.trim()" @click="decide('resolved')">确认结案</button>
            <button :disabled="!reason.trim()" @click="decide('rejected')">驳回反馈</button>
          </div>
        </fieldset>
      </template>
    </template>
  </RecordWorkspace>
</template>
<style scoped>
.hour-appeals { overflow-wrap: anywhere; }
.hour-appeals .entry-list a.selected { border-inline-start: 3px solid var(--brand); }
.hour-appeals .entry-list small { display: block; color: var(--muted); }
.note { white-space: pre-wrap; }
.appeal-decision { min-width: 0; padding: 12px; border: 1px solid var(--line); max-width: 55rem; }
.appeal-decision label { display: grid; gap: 6px; margin-block: 9px; }
.appeal-decision select { width: 100%; min-width: 0; }
</style>
