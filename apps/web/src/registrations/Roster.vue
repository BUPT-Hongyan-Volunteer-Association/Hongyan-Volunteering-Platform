<script lang="ts">
// 仅携带离开名单的提示，不跨活动保存个人数据。
let selectionClearedOnLeave = false;
</script>
<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, onUnmounted, ref, shallowReactive, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import {
  ApiError,
  createCommand,
  decideRegistration,
  decideRegistrationsAtomically,
  type RegistrationDecision,
  listActivityRegistrations,
  type Registration,
  type ActivityRosterPage,
} from '@hongyan/contracts';
import { canChangeRegistration } from '@hongyan/contracts/activity';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import ExportButton from '@hongyan/ui/ExportButton.vue';
import { noAccess } from '@hongyan/ui/usePageRead';
import { useIdSelection } from '@hongyan/ui/useSelection';
import { registrationLabels } from './labels';
import Pager from '@hongyan/ui/Pager.vue';
const props = defineProps<{ writesPaused: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(),
  q = ref(''),
  state = ref<Registration['status'] | ''>('submitted'),
  page = ref(1),
  notice = ref(selectionClearedOnLeave ? '离开上次名单时已清空选择。' : ''),
  inspected = ref<Registration>();
selectionClearedOnLeave = false;
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const filters = ['submitted', 'accepted', 'waitlisted', ''] as const;
const lessCommon = ['rejected', 'withdrawn', 'exited'] as const;
const labels = { ...registrationLabels, submitted: '待处理', waitlisted: '候补' };
const result = ref<ActivityRosterPage>();
const { selected, pageChecked, pageIndeterminate, togglePage } = useIdSelection(
  () => (result.value?.items ?? []).map((row) => row.id),
);
const readError = ref('');
const writeError = ref('');
const saving = ref(false);
const refreshRequired = ref(false);
const command = createCommand();
const filterExportInput = computed(() => ({
  type: 'activity_roster' as const,
  activity_id: String(route.params.id),
  ...(q.value.trim() && { q: q.value.trim() }),
  ...(state.value && { registration_status: state.value }),
}));
const selectedExportInput = computed(() => ({
  type: 'activity_roster' as const,
  activity_id: String(route.params.id),
  registration_ids: [...selected.value],
}));
let serial = 0;
let filterVersion = 0;
let mounted = true;
async function load() {
  const turn = ++serial;
  const reviewing = refreshRequired.value;
  readError.value = '';
  result.value = undefined;
  inspected.value = undefined;
  try {
    const { data } = await listActivityRegistrations({
      path: { id: String(route.params.id) },
      query: {
        scope: 'managed',
        q: q.value.trim() || undefined,
        status: state.value || undefined,
        page: page.value,
        page_size: 5,
      },
      throwOnError: true,
    });
    if (turn !== serial) return;
    const lastPage = Math.max(1, Math.ceil(data.data.total / data.data.page_size));
    if (page.value > lastPage) {
      page.value = lastPage;
      return;
    }
    result.value = data.data;
    if (reviewing) refreshRequired.value = false;
  } catch (e) {
    if (turn !== serial) return;
    readError.value = e instanceof Error ? e.message : '名单读取失败';
    if (noAccess(e)) discardRoster();
  }
}
const snapshots = shallowReactive(new Map<string, Registration>());
const conflicts = ref<{ id: string; text: string }[]>([]);
const batchReason = ref(''), singleReason = ref('');
function discardRoster() {
  serial++;
  filterVersion++;
  result.value = undefined;
  inspected.value = undefined;
  selected.value.clear();
  conflicts.value = [];
  notice.value = '';
  writeError.value = '';
  emit('denied');
}
watch(inspected, () => { singleReason.value = ''; }, { flush: 'sync' });
watch(() => [...selected.value], ids => {
  if (!ids.length || ids.some(id => !snapshots.has(id))) batchReason.value = '';
  for (const id of snapshots.keys()) if (!selected.value.has(id)) snapshots.delete(id);
  for (const row of result.value?.items ?? [])
    if (selected.value.has(row.id) && !snapshots.has(row.id)) snapshots.set(row.id, row);
}, { flush: 'sync' });
type Decision = RegistrationDecision['decision'];
const actions = { accepted: '录取', waitlisted: '设为候补', rejected: '不录取' } as const;
const paused = computed(() => saving.value || refreshRequired.value || props.writesPaused || !result.value?.can_decide);
function allowed(decision: Decision, rows: Registration[]) {
  return !!result.value && rows.length > 0 && rows.length <= 100 &&
    rows.every(r => canChangeRegistration(r.status, decision)) &&
    (decision !== 'accepted' || rows.length <= result.value.capacity - result.value.accepted_count);
}
const batch = computed(() => [...snapshots.values()]);
async function decide(decision: Decision, single?: Registration) {
  if (paused.value) return;
  const rows = single ? [single] : batch.value;
  if (!allowed(decision, rows)) return;
  const activityId = String(route.params.id);
  const filterKey = filterVersion;
  saving.value = true;
  writeError.value = '';
  conflicts.value = [];
  const reason = (single ? singleReason : batchReason).value.trim();
  const decisionInput = { decision, ...(reason && { reason }) };
  try {
    if (single) {
      const body = { ...decisionInput, expected_version: single.version };
      await decideRegistration({ path: { id: single.id }, query: { scope: 'managed' }, body,
        headers: command.headers('decide_registration', single.id, body), throwOnError: true });
    } else {
      const body = { ...decisionInput, items: rows.map(r => ({ registration_id: r.id, expected_version: r.version })) };
      await decideRegistrationsAtomically({ path: { id: activityId }, query: { scope: 'managed' }, body,
        headers: command.headers('bulk', activityId, body), throwOnError: true });
    }
    command.confirmed();
    if (!mounted || activityId !== route.params.id) return;
    if (filterKey !== filterVersion) { await load(); return; }
    const who = single ? single.student_name : rows.length + ' 人';
    notice.value = decision === 'waitlisted' ? '已将' + who + '设为候补。'
      : decision === 'accepted' ? '已录取' + who + '。' : who + '已标为未录取。';
    const remaining = new Set(selected.value);
    for (const r of rows) remaining.delete(r.id);
    selected.value = remaining;
    await load();
  } catch (e) {
    if (!mounted || activityId !== route.params.id) return;
    if (noAccess(e)) {
      discardRoster();
      readError.value = e instanceof Error ? e.message : '名单不可见';
      return;
    }
    if (filterKey !== filterVersion) return;
    writeError.value = e instanceof Error ? e.message : '决定提交失败';
    refreshRequired.value = e instanceof ApiError && e.status === 409;
    if (e instanceof ApiError) conflicts.value = (e.body?.details ?? []).flatMap(d => {
      const r = rows.find(r => r.id === d.resource_id);
      return r ? [{ id: r.id, text: r.student_name + '（' + r.student_no + '）' + d.message }] : [];
    });
  } finally { saving.value = false; }
}
function reviewedRow(id: string) {
  const fresh = result.value?.items.find(r => r.id === id);
  return fresh && fresh.version !== snapshots.get(id)?.version ? fresh : undefined;
}
function confirmVersion(id: string) {
  const row = reviewedRow(id);
  if (!row) return;
  snapshots.set(id, row);
  conflicts.value = conflicts.value.filter(c => c.id !== id);
}
const otherStates = computed(() => [
  { value: '', label: '其他状态', disabled: true },
  ...lessCommon.map((value) => ({
    value,
    label: labels[value] + ' ' + (result.value?.status_counts[value] ?? 0),
  })),
]);
function clear() {
  filterVersion++;
  conflicts.value = [];
  batchReason.value = '';
  notice.value = selected.value.size ? '筛选或活动已变更，已清空选择。' : '';
  inspected.value = undefined;
  writeError.value = '';
  selected.value.clear();
  page.value = 1;
}
watch([q, state, () => route.params.id], clear, { flush: 'sync' });
watch([() => route.params.id, q, state, page], load, { immediate: true });
onBeforeRouteLeave(() => { selectionClearedOnLeave = selected.value.size > 0; });
onUnmounted(() => {
  mounted = false;
  serial++;
});
</script>
<template>
  <div class="roster-heading">
    <div class="page-title">
      <h2>报名名单</h2>
    </div>
    <p v-if="result" class="capacity">
      <UiIcon name="User" /> 已占
      <strong>{{ result.accepted_count }} / {{ result.capacity }}</strong> 人
    </p>
  </div>
  <div class="page-actions">
    <RouterLink class="button" :to="{ path: '/managed/' + route.params.id + '/requests', query: { page: route.query.page } }">退出与恢复</RouterLink>
  </div>
  <div v-if="result" class="status-filters" aria-label="报名状态">
    <button v-for="key in filters" :key="key" :aria-pressed="state === key" @click="state = key">
      {{ key ? labels[key] : '全部' }}
      <b>{{
        key
          ? result.status_counts[key]
          : Object.values(result.status_counts).reduce((a, b) => a + b, 0)
      }}</b>
    </button>
    <UiSelect
      label="其他报名状态"
      :model-value="lessCommon.some((k) => k === state) ? state : ''"
      :options="otherStates"
      @update:model-value="state = $event as Registration['status']"
    />
  </div>
  <div class="page-actions roster-tools">
    <label class="search-field"
      ><UiIcon name="Search" /><input
        aria-label="姓名或学号"
        type="search"
        placeholder="搜索姓名或学号"
        v-model="q"
    /></label>
    <span class="state-chip attention">已选 {{ selected.size }} 人</span>
    <label v-if="selected.size">所选人员的处理说明（选填）<input v-model="batchReason" maxlength="1000" /></label>
    <button v-for="(label, key) in actions" :key="key" :disabled="paused || !allowed(key, batch)"
      @click="decide(key)">{{ key === 'waitlisted' ? '所选设为候补' : label + '所选' }}</button>
    <ExportButton
      :input="filterExportInput"
      :disabled="saving || writesPaused || !result"
      create-label="导出筛选结果"
      download-label="下载名单文件"
      @recheck="load"
    />
    <ExportButton
      :input="selectedExportInput"
      :disabled="!selected.size || saving || writesPaused || !result"
      :create-label="'导出所选名单' + (selected.size ? '（' + selected.size + '）' : '')"
      download-label="下载所选名单"
      @recheck="load"
    />
  </div>
  <p v-if="result && selected.size && selected.size <= 100">
    <template v-if="!result.can_decide">本活动的报名决定已关闭。</template>
    <template v-else-if="batch.every(r => canChangeRegistration(r.status, 'accepted')) && selected.size > result.capacity - result.accepted_count">
      当前余量不足以录取全部所选人员。<button @click="load">刷新余量</button>
    </template>
    <template v-else-if="!Object.keys(actions).some(k => allowed(k as Decision, batch))">所选状态无法统一办理，请调整选择或导出名单。</template>
  </p>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="writeError" role="alert">
    {{ writeError }}
    <button
      v-if="refreshRequired"
      @click="
        writeError = '';
        load();
      "
    >
      刷新名单复核
    </button>
  </p>
  <ul v-if="conflicts.length" aria-label="冲突记录">
    <li v-for="c in conflicts" :key="c.id">{{ c.text }}
      <button v-if="!paused && selected.has(c.id) && reviewedRow(c.id)" @click="confirmVersion(c.id)">
        采用当前状态（{{ labels[reviewedRow(c.id)!.status] }}）
      </button>
      <button v-if="selected.has(c.id)" @click="selected.delete(c.id)">移出选择</button>
    </li>
  </ul>
  <p v-if="readError" role="alert">{{ readError }} <button @click="load">重新读取名单</button></p>
  <p v-else-if="!result" role="status">正在读取名单…</p>
  <template v-if="result">
    <div class="scroll-table data-grid">
      <table>
        <thead>
          <tr>
            <th>
              <label class="check-cell">
                <input
                  type="checkbox"
                  aria-label="选择本页"
                  :indeterminate="pageIndeterminate"
                  :checked="pageChecked"
                  @change="togglePage(($event.target as HTMLInputElement).checked)"
              /></label>
            </th>
            <th>姓名</th>
            <th>学号</th>
            <th>申请时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in result.items" :key="r.id" :class="{ selected: selected.has(r.id) }">
            <td>
              <label class="check-cell">
                <input
                  type="checkbox"
                  :aria-label="'选择' + r.student_name"
                  :value="r.id"
                  v-model="selected"
              /></label>
            </td>
            <td>{{ r.student_name }}</td>
            <td>{{ r.student_no }}</td>
            <td>{{ time.format(new Date(r.submitted_at)) }}</td>
            <td>
              <span class="icon-label"><UiIcon name="Document" />{{ labels[r.status] }}</span>
            </td>
            <td>
              <button class="view-row" :aria-label="'查看' + r.student_name" @click="inspected = r">
                查看
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!result.total">暂无匹配的报名</p>
    <div class="roster-pager">
      <div>
        <small>本页 {{ result.items.length }} 人，共 {{ result.total }} 人</small
        ><small v-if="selected.size > 100">每批最多办理 100 人</small>
      </div>
      <Pager
        :page="page"
        :size="5"
        :total="result.total"
        @change="
          (p) => {
            page = p;
            inspected = undefined;
          }
        "
      />
    </div>
  </template>
  <section v-if="inspected" class="record">
    <div class="page-title">
      <h3>{{ inspected.student_name }}的报名记录</h3>
      <button @click="inspected = undefined">收起记录</button>
    </div>
    <dl>
      <dt>学号</dt>
      <dd>{{ inspected.student_no }}</dd>
      <dt>申请时间</dt>
      <dd>{{ time.format(new Date(inspected.submitted_at)) }}</dd>
      <dt>状态</dt>
      <dd>{{ labels[inspected.status] }}</dd>
      <template v-if="inspected.statement"
        ><dt>申请说明</dt>
        <dd>{{ inspected.statement }}</dd></template
      >
      <template v-if="inspected.decision_reason"
        ><dt>处理说明</dt>
        <dd>{{ inspected.decision_reason }}</dd></template
      >
    </dl>
    <template v-if="['submitted', 'waitlisted', 'rejected'].includes(inspected.status)">
      <label class="single-note">给{{ inspected.student_name }}的处理说明（选填）<textarea v-model="singleReason" maxlength="1000" rows="2" /></label>
      <button v-for="(label,key) in actions" :key="key"
        :disabled="paused || !allowed(key, [inspected])"
        @click="decide(key, inspected)">{{ key === 'accepted' && inspected.status === 'waitlisted' ? '手动补录' : label + '此人' }}</button>
    </template>
    <small
      v-if="result && result.accepted_count >= result.capacity && inspected.status !== 'accepted'"
      >名额已满</small
    >
  </section>
</template>
<style scoped>
.single-note { display: grid; gap: 6px; max-width: 36rem; margin-block: 12px; }
.roster-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 10px;
}
.roster-heading .capacity {
  margin: 0 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.capacity .ui-icon,
.icon-label .ui-icon {
  color: var(--brand);
}
.status-filters button b {
  font-variant-numeric: tabular-nums;
}
.roster-tools .search-field {
  margin-right: auto;
}
.roster-tools .ui-icon {
  width: 16px;
  height: 16px;
}
.record {
  margin-top: 10px;
}
#roster-note {
  margin-left: 12px;
}
@media (max-width: 700px) {
  .roster-tools .search-field {
    width: 100%;
  }
  .roster-tools .search-field input {
    width: 100%;
  }
  .roster-tools {
    gap: 6px;
  }
  .roster-tools button {
    font-size: 13px;
    padding-inline: 8px;
  }
}
.page-title h2 {
  font-size: 20px;
}
.capacity {
  margin: 14px 0 4px;
  font-size: 15px;
}
.capacity strong {
  font-size: 20px;
}
.status-filters,
.roster-pager {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.status-filters {
  border-bottom: 1px solid var(--line);
}
.status-filters button {
  border: 0;
  border-radius: 0;
  color: var(--muted);
  padding: 10px 6px;
}
.status-filters button[aria-pressed='true'] {
  color: var(--brand);
  box-shadow: inset 0 -3px var(--brand);
  font-weight: 650;
}
.status-filters {
  --select-width: 7rem;
}
.roster-tools {
  margin: 16px 0;
}
.roster-tools input {
  margin-right: auto;
  width: min(100%, 230px);
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--brand);
}
.view-row {
  border: 0;
  background: transparent;
  font-weight: 600;
}
.roster-pager {
  justify-content: space-between;
}
.roster-pager small {
  color: var(--muted);
}
.record {
  padding: 12px 16px;
  background: var(--surface);
  border-radius: 6px;
}
.check-cell {
  display: grid;
  place-items: center;
  min-width: 44px;
  min-height: 36px;
  cursor: pointer;
}
.check-cell input {
  margin: 0;
}
@media (max-width: 700px), (pointer: coarse) {
  .check-cell {
    min-height: 44px;
  }
}
.data-grid tr > :first-child {
  min-width: 44px;
  width: 44px;
  padding: 0;
  text-align: center;
}
.data-grid tr > :nth-child(2) {
  position: sticky;
  left: 44px;
  background: white;
}
.data-grid thead tr > :nth-child(2) {
  background: var(--surface);
}
.data-grid tr.selected > :nth-child(2) {
  background: #eaf2ff;
}
</style>
