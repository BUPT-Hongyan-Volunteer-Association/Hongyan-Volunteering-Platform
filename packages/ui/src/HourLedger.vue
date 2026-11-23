<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listActivityHours, listMyHours, listStudentHours, type HourRecord } from '@hongyan/contracts';
import ActivityDateField from './ActivityDateField.vue';
import ExportButton from './ExportButton.vue';
import Pager from './Pager.vue';
import { beijing } from './hourDisplay';
import { pageNumber, usePageRead } from './usePageRead';

const props = defineProps<{ scope: { type: 'my_hours' } | { type: 'activity_hours'; activity_id: string }
  | { type: 'admin_student_hours'; student_id: string }; title: string; batchBase?: string; groupBase?: string }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(), router = useRouter();
const size = 20;
const page = computed(() => pageNumber(route.query.hour_page));
const filters = computed(() => ({
  from_date: typeof route.query.from_date === 'string' ? route.query.from_date : undefined,
  to_date: typeof route.query.to_date === 'string' ? route.query.to_date : undefined,
  include_history: route.query.include_history === 'true',
}));
const exportInput = computed(() => ({ ...props.scope, ...filters.value }));
const from = ref(''), to = ref(''), history = ref(false);
watch(filters, (current) => {
  from.value = current.from_date ?? ''; to.value = current.to_date ?? ''; history.value = current.include_history;
}, { immediate: true });
watch(
  [
    () => filters.value.from_date,
    () => filters.value.to_date,
    () => filters.value.include_history,
    () => props.scope.type === 'activity_hours' ? props.scope.activity_id : '',
  ],
  () => selected.value.clear(),
);
function applyFilters() {
  return router.replace({ query: { ...route.query, from_date: from.value || undefined, to_date: to.value || undefined,
    include_history: history.value ? 'true' : undefined, hour_page: undefined } });
}
function goPage(next: number) {
  void router.push({ query: { ...route.query, hour_page: String(next) } });
}
const { data, error, loading, refresh, clear } = usePageRead(
  () => [props.scope, page.value, filters.value], async (signal) => {
    const query = { ...filters.value, page: page.value, page_size: size };
    const scope = props.scope;
    const options = { query, signal, throwOnError: true as const };
    if (scope.type === 'my_hours') return (await listMyHours(options)).data.data;
    if (scope.type === 'activity_hours') return (await listActivityHours({ path: { id: scope.activity_id }, ...options })).data.data;
    return (await listStudentHours({ path: { id: scope.student_id }, ...options })).data.data;
  }, () => emit('denied'),
);
const selected = ref(new Set<string>());
const summaryExportInput = computed(() => ({
  type: 'activity_hours' as const,
  activity_id: props.scope.type === 'activity_hours' ? props.scope.activity_id : '',
  from_date: filters.value.from_date,
  to_date: filters.value.to_date,
  student_ids: [...selected.value],
}));
const pageStudents = computed(() => [...new Set((data.value?.items ?? []).map((row) => row.student_id))]);
const pageChecked = computed(() => pageStudents.value.length > 0 && pageStudents.value.every((id) => selected.value.has(id)));
const pageIndeterminate = computed(() => !pageChecked.value && pageStudents.value.some((id) => selected.value.has(id)));
function togglePage(checked: boolean) {
  const next = new Set(selected.value);
  for (const id of pageStudents.value) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  selected.value = next;
}
function toggleStudent(id: string, checked: boolean) {
  const next = new Set(selected.value);
  if (checked) next.add(id);
  else next.delete(id);
  selected.value = next;
}
const statuses: Record<HourRecord['status'], string> = { current: '有效', superseded: '已更正', voided: '已撤销' };
defineExpose({ refresh, clear });
</script>
<template>
  <section class="ledger">
    <div class="page-title"><h1>{{ title }}</h1></div>
    <slot name="links" />
    <form class="hour-filters" @submit.prevent="applyFilters">
      <div>起始日期<ActivityDateField label="起始日期" v-model="from" /></div>
      <div>结束日期<ActivityDateField label="结束日期" v-model="to" /></div>
      <label><input type="checkbox" v-model="history" />包含更正与撤销历史</label>
      <button type="submit" class="primary">查询时长</button>
    </form>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重读台账</button></p>
    <p v-else-if="loading && !data" role="status">正在读取台账…</p>
    <div v-if="data || loading" class="ledger-summary">
      <template v-if="data">
        <p>筛选范围内累计 <strong>{{ data.total_hours }} 小时</strong></p>
        <span class="meta-line">共 {{ data.total }} 条记录</span>
      </template>
      <template v-if="scope.type === 'activity_hours'">
        <span class="meta-line">已选 {{ selected.size }} 名学生</span>
        <ExportButton
          :key="'detail-' + JSON.stringify(exportInput)"
          :input="exportInput"
          :disabled="loading || !data"
          create-label="导出全部明细"
          download-label="下载全部明细"
          @recheck="refresh(false)"
        />
        <ExportButton
          :key="'summary-' + JSON.stringify(summaryExportInput)"
          :input="summaryExportInput"
          :disabled="loading || !data || !selected.size"
          create-label="导出所选学生汇总"
          download-label="下载所选学生汇总"
          @recheck="refresh(false)"
        />
      </template>
      <ExportButton v-else :key="JSON.stringify(exportInput)" :input="exportInput" :disabled="loading || !data" @recheck="refresh(false)" />
    </div>
    <template v-if="data">
      <p v-if="!data.items.length">当前条件下没有时长记录。</p>
      <div v-else class="scroll-table ledger-table">
        <table aria-label="时长明细">
          <thead><tr>
            <th v-if="scope.type === 'activity_hours'" class="select-cell">
              <input
                v-if="pageStudents.length"
                type="checkbox"
                aria-label="选择本页学生"
                :checked="pageChecked"
                :indeterminate="pageIndeterminate"
                @change="togglePage(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th v-if="scope.type === 'activity_hours'">学生</th>
            <th scope="col">活动</th><th scope="col">服务日期</th><th scope="col">时长</th>
            <th scope="col">状态</th><th scope="col">账务来源</th>
            <th v-if="$slots.actions" scope="col">操作</th>
          </tr></thead>
          <tbody><tr v-for="row in data.items" :key="row.id" :class="{ selected: route.query.record === row.id }">
            <td v-if="scope.type === 'activity_hours'" class="select-cell">
              <input
                type="checkbox"
                :aria-label="'选择学生 ' + row.student_no"
                :checked="selected.has(row.student_id)"
                @change="toggleStudent(row.student_id, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td v-if="scope.type === 'activity_hours'" data-label="学生">{{ row.student_name }}<small>{{ row.student_no }}</small></td>
            <th scope="row">{{ row.activity_title ?? row.activity_code }}<small v-if="row.activity_title">{{ row.activity_code }}</small></th>
            <td data-label="服务日期">{{ row.service_date }}</td>
            <td data-label="时长">{{ row.credited_hours }} 小时</td>
            <td data-label="状态"><span class="state-chip" :class="{ neutral: row.status !== 'current' }">{{ statuses[row.status] }}</span></td>
            <td data-label="账务来源">
              <details>
                <summary>获批安排 v{{ row.origin_schedule_revision }}</summary>
                <div class="ledger-source">
                  <span v-if="row.reviewed_at">入账 {{ beijing(row.reviewed_at) }}</span>
                  <span v-if="row.batch_id">入账批次
                    <RouterLink v-if="batchBase" :to="batchBase + '/' + row.batch_id">H-{{ row.batch_id }}</RouterLink>
                    <span v-else>H-{{ row.batch_id }}</span>
                  </span>
                  <span v-if="row.correction_group_id">补记修复组
                    <RouterLink v-if="groupBase" :to="groupBase + '/' + row.correction_group_id">{{ row.correction_group_id }}</RouterLink>
                    <span v-else>{{ row.correction_group_id }}</span>
                  </span>
                  <span v-if="row.voided_by_batch_id">撤销批次 H-{{ row.voided_by_batch_id }}</span>
                  <span v-if="row.voided_by_group_id">撤销修复组 {{ row.voided_by_group_id }}</span>
                  <span v-if="row.supersedes_record_id">前一笔记录 {{ row.supersedes_record_id }}</span>
                  <span>记录编号 {{ row.id }}</span>
                  <span v-if="row.remark">{{ row.remark }}</span>
                </div>
              </details>
            </td>
            <td v-if="$slots.actions" data-label="操作"><slot name="actions" :row="row" /></td>
          </tr></tbody>
        </table>
      </div>
      <Pager v-if="data.total > size" :page="page" :size="size" :total="data.total" @change="goPage" />
    </template>
  </section>
</template>
<style scoped>
.hour-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-block: 16px; }
.hour-filters label { align-self: center; }
.ledger-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; background: var(--surface); padding: 10px 14px; margin-bottom: 12px; }
.ledger-summary p { margin: 0; }
.ledger-summary strong { color: var(--brand); font-size: 20px; font-variant-numeric: tabular-nums; }
.ledger-summary :deep(.page-actions) { margin: 0; }
.ledger-summary > :deep(.page-actions) { display: contents; }
.select-cell { width: 2.5rem; }
.ledger-table th, .ledger-table td { white-space: normal; overflow-wrap: anywhere; vertical-align: top; }
.ledger-table small { display: block; color: var(--muted); }
.ledger-source { display: grid; gap: 4px; min-width: 10rem; max-width: 24rem; font-size: 13px; }
@media (max-width: 700px) {
  .ledger-table thead { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; }
  .ledger-table tbody, .ledger-table tbody tr, .ledger-table tbody th { display: block; }
  .ledger-table tr { border-block-end: 1px solid var(--line); padding-block: 8px; }
  .ledger-table tbody td { display: grid; grid-template-columns: 6em minmax(0, 1fr); gap: 6px; }
  .ledger-table tbody td::before { content: attr(data-label); color: var(--muted); }
  .ledger-table tbody :is(td,th) { padding-block: 4px; border: 0; }
}
</style>
