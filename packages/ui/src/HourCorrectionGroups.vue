<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError, createCommand, getHourCorrectionGroup, listActivityHourCorrectionGroups, listHourCorrectionGroups,
  reviewHourCorrectionGroup, withdrawHourCorrectionGroup, type HourCorrectionGroup, type Profile,
} from '@hongyan/contracts';
import Pager from './Pager.vue';
import StatusFilter from './StatusFilter.vue';
import RecordWorkspace from './RecordWorkspace.vue';
import HourCorrectionForm from './HourCorrectionForm.vue';
import HourWarnings from './HourWarnings.vue';
import { beijing, useReviewWarnings } from './hourDisplay';
import { message, noAccess, pageNumber, usePageRead } from './usePageRead';

const props = defineProps<{ admin?: boolean; profile?: Profile; writesPaused?: boolean; activityId?: string; accountId?: string }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(), router = useRouter();
const activityId = computed(() => props.activityId ?? (props.admin ? undefined : String(route.params.id)));
const base = computed(() => props.admin ? '/manage/corrections' : '/managed/' + activityId.value + '/corrections');
const id = computed(() => String(route.params.item ?? ''));
const creating = computed(() => route.query.new === '1' && !id.value);
const page = computed(() => pageNumber(route.query.group_page));
const mode = computed(() => route.query.group_status === 'pending_review' ? 'pending_review' as const : undefined);
const labels: Record<HourCorrectionGroup['status'], string> = {
  pending_review: '待审核', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回',
};
const savedMessage = ref('');
const { data: queue, error: listError, loading: listLoading, refresh: loadQueue } = usePageRead(
  () => [activityId.value, page.value, mode.value], async (signal) => {
    const query = { page: page.value, page_size: 15, status: mode.value };
    const options = { signal, query, throwOnError: true as const };
    return props.admin ? (await listHourCorrectionGroups(options)).data.data
      : (await listActivityHourCorrectionGroups({ ...options, path: { id: activityId.value! } })).data.data;
  }, () => emit('denied'),
);
const { data: group, error: detailError, loading: detailLoading, refresh: loadGroup } = usePageRead(
  () => [id.value, activityId.value], async (signal) => {
    if (!id.value) return;
    const result = (await getHourCorrectionGroup({ path: { id: id.value }, signal, throwOnError: true })).data.data;
    if (!props.admin && !result.items.some((row) => row.source_record.activity_id === activityId.value || row.target_activity_id === activityId.value))
      throw new Error('该修复组不涉及当前活动。');
    return result;
  },
);
const listQuery = computed(() => ({ page: route.query.page, group_page: route.query.group_page, group_status: route.query.group_status }));
function saved(next: HourCorrectionGroup) {
  savedMessage.value = '修复组已提交审核。';
  void router.push({ path: base.value + '/' + next.id, query: listQuery.value });
  void loadQueue();
}

const actor = computed(() => props.profile?.account_id ?? props.accountId);
const canReview = computed(() => props.admin && group.value?.status === 'pending_review' && group.value.submitted_by !== actor.value);
const canWithdraw = computed(() => group.value?.status === 'pending_review' && (props.admin || group.value.submitted_by === actor.value));
const reviewWarnings = useReviewWarnings(() => group.value);
const { warnings } = reviewWarnings;
const reason = ref(''), problem = ref(''), busy = ref(false);
const command = createCommand();
let live = true;
onScopeDispose(() => { live = false; });
watch(id, () => {
  reviewWarnings.reset(); reason.value = ''; problem.value = ''; busy.value = false; command.confirmed();
});
async function act(decision: 'approved' | 'rejected' | 'withdrawn') {
  const current = group.value;
  if (!current || busy.value || props.writesPaused || (decision === 'withdrawn' ? !canWithdraw.value : !canReview.value)) return;
  problem.value = ''; savedMessage.value = '';
  const note = reason.value.trim();
  if (!note && (decision !== 'approved' || warnings.value.length)) {
    problem.value = '请填写处理原因或警告接受依据。'; return;
  }
  const path = { id: current.id };
  busy.value = true;
  try {
    let next: HourCorrectionGroup;
    if (decision === 'withdrawn') {
      const body = { expected_version: current.version, reason: note };
      next = (await withdrawHourCorrectionGroup({ path, body, throwOnError: true,
        headers: command.headers('withdraw_hour_correction_group', current.id, body) })).data.data;
    } else {
      const body = decision === 'rejected'
        ? { expected_version: current.version, decision, reason: note }
        : { expected_version: current.version, decision, ...(note && { reason: note }),
          warning_snapshot_hash: reviewWarnings.hash.value };
      next = (await reviewHourCorrectionGroup({ path, body, throwOnError: true,
        headers: command.headers('review_hour_correction_group', current.id, body) })).data.data;
    }
    if (!live || id.value !== current.id) return;
    command.confirmed(); group.value = next; reviewWarnings.reset();
    savedMessage.value = decision === 'approved' ? '修复组已批准，源账与目标账已同步更新。' : '修复组' + labels[next.status] + '。';
    await loadQueue(false);
  } catch (error) {
    if (!live || id.value !== current.id) return;
    problem.value = message(error);
    if (error instanceof ApiError && error.status === 409) {
      command.confirmed();
      if (reviewWarnings.refreshFrom(error)) {
        reason.value = '';
      } else if (error.body?.code !== 'target_key_conflict') await loadGroup();
    } else if (noAccess(error)) {
      await loadGroup();
      await loadQueue();
    }
  } finally { if (live && id.value === current.id) busy.value = false; }
}
</script>
<template>
  <section class="corrections">
    <h1>错帐修复</h1>
    <p v-if="savedMessage" role="status">{{ savedMessage }}</p>
    <template v-if="creating">
      <RouterLink class="back-link" :to="{ path: base, query: listQuery }">返回修复列表</RouterLink>
      <HourCorrectionForm :activity-id="activityId" :admin="!!admin" :disabled="writesPaused" @saved="saved" @denied="emit('denied')" />
    </template>
    <RecordWorkspace v-else :selected="!!id">
      <template #list>
        <div class="page-actions correction-tools">
          <RouterLink class="button" :to="{ path: base, query: { ...listQuery, new: '1' } }">新建修复申请</RouterLink>
          <StatusFilter v-if="admin" label="审核状态" :model-value="mode ?? 'all'"
            :options="{ all: '全部', pending_review: '待审核' }"
            @update:model-value="router.push({ path: base, query: { group_status: $event === 'all' ? undefined : $event } })" />
        </div>
        <p v-if="listError" role="alert">{{ listError }} <button @click="loadQueue()">重读修复列表</button></p>
        <p v-else-if="listLoading && !queue" role="status">正在读取修复列表…</p>
        <p v-else-if="!queue?.total">当前没有修复申请。</p>
        <div v-else class="entry-list">
          <RouterLink v-for="item in queue.items" :key="item.id" :to="{ path: base + '/' + item.id, query: listQuery }"
            :class="{ selected: item.id === id }">
            <div><strong>{{ item.items.length }} 对错帐修复</strong><small>{{ beijing(item.created_at) }} · {{ item.id.slice(0, 8) }}</small></div>
            <span class="state-chip">{{ labels[item.status] }}</span>
          </RouterLink>
        </div>
        <Pager v-if="queue && queue.total > queue.page_size" :page="page" :size="queue.page_size" :total="queue.total"
          @change="router.push({ path: route.path, query: { ...listQuery, group_page: String($event) } })" />
      </template>
      <template #detail>
        <RouterLink class="back-link" :to="{ path: base, query: listQuery }">返回修复列表</RouterLink>
        <p v-if="detailError" role="alert">{{ detailError }} <button @click="loadGroup()">重读详情</button></p>
        <p v-else-if="detailLoading && !group" role="status">正在读取修复快照…</p>
        <template v-if="group">
          <div class="page-title"><h2>修复组 {{ group.id.slice(0, 8) }}</h2><span class="state-chip">{{ labels[group.status] }}</span></div>
          <p>送审 {{ beijing(group.created_at) }} · 共 {{ group.items.length }} 对</p>
          <p>{{ group.reason }}</p>
          <p v-if="group.decision_reason">处理意见：{{ group.decision_reason }}</p>
          <ol class="repair-pairs">
            <li v-for="item in group.items" :key="item.source_record.id">
              <div class="pair-record">
                <strong>源账</strong><span>{{ item.source_record.student_name }} · {{ item.source_record.student_no }}</span>
                <span>{{ item.source_record.activity_title ?? item.source_record.activity_code }} · {{ item.source_record.service_date }}</span>
                <span>{{ item.source_record.credited_hours }} 小时 · 获批安排 v{{ item.source_record.origin_schedule_revision }}</span>
              </div>
              <div class="pair-record">
                <strong>目标账</strong><span>{{ item.target_student_name }} · {{ item.target_student_no }}</span>
                <span>{{ item.target_activity_title ?? item.target_activity_id }} · {{ item.target_service_date }}</span>
                <span>{{ item.credited_hours }} 小时 · 获批安排 v{{ item.target_schedule_revision }}</span>
              </div>
              <p>{{ item.reason }}</p>
            </li>
          </ol>
          <HourWarnings :warnings="warnings" repair-pairs />
          <p v-if="problem" role="alert">{{ problem }}</p>
          <template v-if="canReview || canWithdraw">
            <label class="correction-reason">{{ warnings.length && canReview ? '处理意见与警告接受依据' : '处理意见' }}
              <textarea v-model="reason" maxlength="2000" rows="3" :disabled="busy || writesPaused" />
            </label>
            <div class="page-actions">
              <button v-if="canReview" class="primary" :disabled="busy || writesPaused" @click="act('approved')">批准整组</button>
              <button v-if="canReview" :disabled="busy || writesPaused" @click="act('rejected')">驳回整组</button>
              <button v-if="canWithdraw" :disabled="busy || writesPaused" @click="act('withdrawn')">撤回修复组</button>
            </div>
          </template>
        </template>
      </template>
    </RecordWorkspace>
  </section>
</template>
<style scoped>
.correction-tools { align-items: end; }
.corrections { min-width: 0; overflow-wrap: anywhere; }
.entry-list small { display: block; color: var(--muted); }
.entry-list a.selected { border-inline-start: 3px solid var(--brand); }
.repair-pairs { padding-inline-start: 1.4rem; }
.repair-pairs li { padding: 10px 8px; margin-block: 8px; border-block-start: 1px solid var(--line); }
.pair-record { display: grid; grid-template-columns: 4rem 1fr; gap: 4px; margin-bottom: 8px; }
.pair-record span { grid-column: 2; }
.correction-reason { display: grid; gap: 6px; margin-block: 12px; }
</style>
