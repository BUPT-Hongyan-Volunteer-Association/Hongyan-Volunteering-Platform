<script setup lang="ts">
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError, createCommand, getHourBatch, getHourBatchRows, listHourBatchesForReview,
  listIncidentsForReview, reviewHourBatch, type HourBatch, type HourBatchReviewDecision,
  type HourMisconductReviewInput, type Profile,
} from '@hongyan/contracts';
import StatusFilter from '@hongyan/ui/StatusFilter.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import Pager from '@hongyan/ui/Pager.vue';
import HourWarnings from '@hongyan/ui/HourWarnings.vue';
import { actions, useReviewWarnings, beijing, misconductLabels, modes, signed, statuses } from '@hongyan/ui/hourDisplay';
import { message, noAccess, pageNumber, usePageRead } from '@hongyan/ui/usePageRead';

const props = defineProps<{ profile: Profile }>();
const route = useRoute(), router = useRouter();
const id = computed(() => String(route.params.id ?? ''));
const queuePage = computed(() => pageNumber(route.query.page));
const status = computed(() => String(route.query.status ?? 'pending_review') as HourBatch['status'] | 'all');
const { data: queue, error: queueError, loading: queueLoading, refresh: loadQueue } = usePageRead(
  () => [id.value, queuePage.value, status.value],
  async (signal) => id.value ? undefined : (await listHourBatchesForReview({
    query: { page: queuePage.value, status: status.value === 'all' ? undefined : status.value }, signal, throwOnError: true,
  })).data.data,
);
function setQueue(query: { status?: string; page: number }) {
  void router.push({ path: '/hours', query: { ...route.query, ...query } });
}
const { data: batch, error: detailError, loading: detailLoading, refresh: loadBatch } = usePageRead(id, async (signal) =>
  id.value ? (await getHourBatch({ path: { id: id.value }, signal, throwOnError: true })).data.data : undefined,
);
const page = ref(1), size = ref(20), only = ref(false), activeNumber = ref<number>();
const { data: detail, error: rowsError, loading: rowsLoading, refresh: loadRows, clear: clearRows } = usePageRead(
  () => [id.value, page.value, size.value, only.value], async (signal) => id.value ? (await getHourBatchRows({
    path: { id: id.value }, query: { page: page.value, page_size: size.value, misconduct_requires_review: only.value || undefined },
    signal, throwOnError: true,
  })).data.data : undefined, () => void loadBatch(),
);
const rows = computed(() => detail.value?.items ?? []);
const canDecide = computed(() => batch.value?.status === 'pending_review' && batch.value.submitted_by !== props.profile.account_id);
type Draft = { decision: '' | 'confirmed' | 'rejected'; reason: string; incident?: { id: string; version: number } };
const drafts = reactive<Record<number, Draft>>({});
const active = computed(() => rows.value.find((row) => row.row_number === activeNumber.value && row.misconduct_requires_review));
const selected = computed(() => active.value ? drafts[active.value.row_number] : undefined);
const checked = computed(() => Object.values(drafts).filter((draft) => draft.decision && draft.reason.trim()).length);
const { data: matches, error: matchesError, refresh: loadMatches } = usePageRead(
  () => [active.value, selected.value?.decision, canDecide.value],
  async (signal) => {
    const row = active.value, current = batch.value;
    if (!canDecide.value || selected.value?.decision !== 'confirmed' || !row?.student_id || !current) return [];
    return (await listIncidentsForReview({ query: {
      status: 'confirmed', student_id: row.student_id, activity_id: current.activity_id, service_date: row.service_date, page_size: 100,
    }, signal, throwOnError: true })).data.data.items;
  },
);
async function activate(number: number, focus = false) {
  activeNumber.value = number;
  drafts[number] ??= { decision: '', reason: '' };
  if (focus) { await nextTick(); document.getElementById('hour-row-heading')?.focus(); }
}
function linkIncident(event: Event) {
  if (!selected.value) return;
  const linked = matches.value?.find((incident) => incident.id === (event.target as HTMLSelectElement).value);
  selected.value.incident = linked ? { id: linked.id, version: linked.version } : undefined;
}
watch(detail, (current) => {
  if (!current || !canDecide.value) return;
  if (!current.items.some((row) => row.row_number === activeNumber.value)) {
    const first = current.items.find((row) => row.misconduct_requires_review);
    activeNumber.value = undefined;
    if (first) activate(first.row_number);
  }
});
watch([only, size], () => { page.value = 1; });

const reviewWarnings = useReviewWarnings(() => batch.value);
const { warnings } = reviewWarnings;
const reason = ref(''), basis = ref(''), result = ref(''), problem = ref(''), busy = ref(false);
const command = createCommand();
let live = true;
onScopeDispose(() => { live = false; });
watch(id, () => {
  for (const key of Object.keys(drafts)) delete drafts[Number(key)];
  only.value = false; page.value = 1; activeNumber.value = undefined;
  reviewWarnings.reset(); basis.value = ''; reason.value = '';
  problem.value = ''; result.value = ''; busy.value = false;
  command.confirmed();
});
async function decide(decision: 'approved' | 'rejected') {
  const current = batch.value, target = id.value;
  if (!current || !canDecide.value || busy.value) return;
  result.value = ''; problem.value = '';
  const remarks = Object.entries(drafts).flatMap(([number, draft]): HourMisconductReviewInput[] => {
    if (!draft.decision || !draft.reason.trim()) return [];
    const incident = draft.decision === 'confirmed' ? draft.incident : undefined;
    return [{ row_number: Number(number), decision: draft.decision, reason: draft.reason.trim(),
      ...(incident && { existing_incident_id: incident.id, existing_incident_version: incident.version }),
    }];
  });
  if (decision === 'approved' && remarks.length !== (current.misconduct_review_required_count ?? 0)) {
    problem.value = '请为全部待核实行填写结论与意见';
    return;
  }
  if (decision === 'approved' && warnings.value.length && !basis.value.trim()) {
    problem.value = '请填写警告接受依据';
    return;
  }
  if (decision === 'rejected' && !reason.value.trim()) {
    problem.value = '请在整批意见中填写驳回原因';
    return;
  }
  const decisionReason = decision === 'approved'
    ? [basis.value.trim(), reason.value.trim()].filter(Boolean).join('\n') : reason.value.trim();
  if ([...decisionReason].length > 2000) {
    problem.value = '审批意见合计须在 2000 字以内';
    return;
  }
  const body: HourBatchReviewDecision = decision === 'rejected'
    ? { expected_version: current.version, decision, reason: decisionReason }
    : { expected_version: current.version, decision, ...(decisionReason && { reason: decisionReason }),
      warning_snapshot_hash: reviewWarnings.hash.value,
      misconduct_reviews: remarks };
  busy.value = true;
  try {
    const { data } = await reviewHourBatch({ path: { id: target }, body,
      headers: command.headers('review_hour_batch', target, body), throwOnError: true });
    if (!live || id.value !== target) return;
    command.confirmed();
    batch.value = data.data;
    reviewWarnings.reset();
    result.value = decision === 'approved' ? '批次已批准，正式时长已更新' : '批次已驳回';
    await loadRows(false);
  } catch (error) {
    if (!live || id.value !== target) return;
    problem.value = message(error);
    if (error instanceof ApiError && error.status === 409) {
      command.confirmed();
      if (reviewWarnings.refreshFrom(error)) {
        basis.value = '';
      } else await loadBatch();
    } else if (noAccess(error)) {
      clearRows();
      await loadBatch();
    }
  } finally { if (live && id.value === target) busy.value = false; }
}
</script>

<template>
  <section v-if="!id">
    <h1>时长审核</h1>
    <StatusFilter label="批次状态" :model-value="status" :options="{ all: '全部', ...statuses }"
      @update:model-value="setQueue({ status: $event, page: 1 })" />
    <p v-if="queueError" role="alert">{{ queueError }} <button @click="loadQueue()">重读队列</button></p>
    <p v-else-if="queueLoading" role="status">正在读取时长批次…</p>
    <p v-else-if="!queue?.total">当前条件下没有时长批次</p>
    <template v-else>
      <div class="entry-list reading-area">
        <RouterLink v-for="row in queue.items" :key="row.id" :to="{ path: '/hours/' + row.id, query: route.query }">
          <div><strong>{{ row.activity_title }} · {{ row.source_file_name ?? modes[row.mode] + '申请' }}</strong>
            <small class="meta-line">{{ row.batch_code }} · {{ row.submitted_by_name ?? '—' }} · {{ beijing(row.submitted_at ?? row.created_at) }} · {{ row.valid_count ?? 0 }} 条</small>
          </div>
          <span class="state-chip">{{ statuses[row.status] }}</span>
        </RouterLink>
      </div>
      <Pager v-if="queue.total > queue.page_size" :page="queuePage" :size="queue.page_size" :total="queue.total"
        @change="setQueue({ page: $event })" />
    </template>
  </section>
  <article v-else class="hour-review">
    <RouterLink class="back-link" :to="{ path: '/hours', query: route.query }">返回时长审核</RouterLink>
    <p v-if="detailError" role="alert">{{ detailError }} <button @click="loadBatch()">重读批次</button></p>
    <p v-else-if="detailLoading && !batch" role="status">正在读取审核详情…</p>
    <template v-if="batch">
      <header>
        <div class="page-title"><h1>时长批次审核</h1><span class="state-chip">{{ statuses[batch.status] }}</span></div>
        <p>{{ batch.activity_title }} · {{ batch.activity_code }}</p>
        <p class="meta-line">{{ batch.batch_code }} · {{ modes[batch.mode] }} · 送审人 {{ batch.submitted_by_name ?? '—' }} · {{ beijing(batch.submitted_at) }}</p>
        <a class="button" v-if="batch.source_file_id" :href="'/api/v1/files/' + batch.source_file_id + '/download'">下载原工作簿 · {{ batch.source_file_name }}</a>
        <p v-if="batch.source_description">批次说明：{{ batch.source_description }}</p>
        <p v-if="batch.reviewed_at">完成于 {{ beijing(batch.reviewed_at) }}<span v-if="batch.decision_reason"> · {{ batch.decision_reason }}</span></p>
      </header>
      <p><strong>全批 {{ batch.row_count ?? 0 }} 行 · 预计差额 {{ signed(batch.projected_delta_hours) }} 小时</strong></p>
      <div class="page-actions review-tools">
        <StatusFilter label="原表行范围" :model-value="only ? 'pending' : 'all'"
          :options="{ all: '全部', pending: '待核实行' }" @update:model-value="only = $event === 'pending'" />
        <label class="size">每页
          <UiSelect label="每页" v-model="size" :options="[5, 20, 50].map(value => ({ value, label: value + ' 条' }))" />
        </label>
      </div>
      <p v-if="rowsError" role="alert">{{ rowsError }} <button @click="loadRows()">重读明细</button></p>
      <p v-else-if="rowsLoading" role="status">正在读取原表行…</p>
      <p v-else-if="!rows.length">当前条件下没有明细</p>
      <div v-if="rows.length" class="scroll-table" tabindex="0" aria-label="原表行审核明细">
        <table>
          <thead><tr><th>原表行</th><th>姓名与学号</th><th>服务日期</th><th>动作</th><th>原值 → 新值（小时）</th><th>行详情</th><th>违纪上报与结论</th></tr></thead>
          <tbody><template v-for="row in rows" :key="row.row_number"><tr :class="{ selected: row.row_number === activeNumber }">
            <th scope="row">
              <button v-if="row.misconduct_requires_review && canDecide" :aria-label="'核实原表第' + row.row_number + '行'"
                :aria-pressed="row.row_number === activeNumber" @click="activate(row.row_number, true)">{{ row.row_number }}</button>
              <span v-else>{{ row.row_number }}</span>
            </th>
            <td>{{ row.student_name }}<small>{{ row.student_no }}</small></td><td>{{ row.service_date }}</td>
            <td>{{ actions[row.action] }}</td><td>{{ row.previous_hours ?? '—' }} → {{ row.credited_hours ?? '—' }}</td>
            <td><details><summary>查看安排与备注</summary><div class="long-text">获批版本 {{ row.bound_schedule_revision ?? '—' }}<p>{{ row.remark || '无备注' }}</p></div></details></td>
            <td>{{ row.misconduct_reported ? misconductLabels[row.misconduct_reported] : '—' }}
              <small v-if="row.misconduct_review">{{ row.misconduct_review.decision === 'confirmed' ? '属实' : '不成立' }} · {{ row.misconduct_review.reason }}</small>
              <small v-else-if="row.misconduct_requires_review">{{ drafts[row.row_number]?.reason.trim() && drafts[row.row_number]?.decision ? '已填写' : '待核实' }}</small>
            </td>
          </tr>
          <tr v-if="canDecide && active?.row_number === row.row_number && selected"><td colspan="7">
<section class="verify">
        <div class="page-title"><h2 id="hour-row-heading" tabindex="-1">原表第 {{ active.row_number }} 行核实</h2></div>
        <p><strong>{{ active.student_name }}</strong> · {{ active.remark }}</p>
        <fieldset :disabled="busy">
          <legend>核实结论</legend>
          <label><input type="radio" name="decision" value="confirmed" v-model="selected.decision" />属实</label>
          <label><input type="radio" name="decision" value="rejected" v-model="selected.decision" />不成立</label>
        </fieldset>
        <label class="review-field">核实意见
          <textarea :aria-label="'第' + active.row_number + '行意见'" v-model="selected.reason" maxlength="2000" :disabled="busy" rows="2" />
        </label>
        <label v-if="selected.decision === 'confirmed' && (matches?.length || selected.incident)" class="review-field">关联已确认的同一事实
          <select :value="selected.incident?.id ?? ''" :disabled="busy" @change="linkIncident">
            <option value="">建立本次核实记录</option>
            <option v-for="incident in matches" :key="incident.id" :value="incident.id">{{ incident.facts.slice(0, 100) }}</option>
          </select>
          <small v-if="selected.incident">关联版本 v{{ selected.incident.version }}
            <button v-if="matches?.some(incident => incident.id === selected?.incident?.id && incident.version !== selected?.incident?.version)"
              type="button" :disabled="busy" @click="selected.incident = undefined">清除后重新核对版本</button>
          </small>
        </label>
        <p v-if="matchesError" role="alert">{{ matchesError }} <button @click="loadMatches()">重读已确认异常</button></p>
      </section>
          </td></tr></template></tbody>
        </table>
      </div>
      <Pager v-if="detail && detail.total > detail.page_size" :page="page" :size="detail.page_size" :total="detail.total" @change="page = $event" />

      <HourWarnings :warnings="warnings" />
      <p v-if="result" role="status">{{ result }}</p>
      <p v-if="problem" role="alert">{{ problem }}</p>
      <footer v-if="canDecide">
        <p>已填写 {{ checked }} / {{ batch.misconduct_review_required_count ?? 0 }} 条核实意见</p>
        <label v-if="warnings.length" class="review-field">警告接受依据
          <textarea v-model="basis" maxlength="2000" rows="2" :disabled="busy" />
        </label>
        <label class="review-field">整批意见
          <textarea v-model="reason" maxlength="2000" rows="2" :disabled="busy" placeholder="驳回时填写原因" />
        </label>
        <div class="page-actions">
          <button class="primary" :disabled="busy" @click="decide('approved')">批准整批</button>
          <button :disabled="busy" @click="decide('rejected')">驳回整批</button>
        </div>
      </footer>
      <p v-else-if="batch.status === 'pending_review'">请由另一位审核人处理</p>
    </template>
  </article>
</template>

<style scoped>
.review-tools { margin-block: 14px; }
.review-tools .size { display: flex; align-items: center; gap: 8px; --select-width: 6rem; }
.hour-review { overflow-wrap: anywhere; }
.scroll-table th:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); }
.scroll-table small { display: block; }
.long-text { min-width: 9rem; max-width: 22rem; white-space: normal; }
.verify { width:min(100%, calc(100vw - 72px), var(--form-width)); white-space:normal; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; margin-block: 20px; padding: 14px; }
.verify fieldset { display: flex; gap: 18px; }
.review-field { display: grid; gap: 6px; max-width: 55rem; margin-block: 12px; }
.review-field textarea { width: 100%; }
</style>
