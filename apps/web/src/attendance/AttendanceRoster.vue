<script setup lang="ts">
import { computed, ref } from 'vue';
import { activeRegistrationStatuses } from '@hongyan/contracts/activity';
import { listActivityRegistrations, type Registration } from '@hongyan/contracts';
import { usePageRead } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';

const props = defineProps<{ activityId: string; forNotice?: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const studentIds = defineModel<string[]>({ required: true });
const selected = computed(() => new Set(studentIds.value));
const search = ref('');
const query = ref({ q: '', page: 1 });
const selectionNotice = ref('');
const { data: result, error, refresh } = usePageRead(query, async (signal) =>
  (await listActivityRegistrations({
    path: { id: props.activityId },
    query: { scope: 'managed', page: query.value.page, page_size: 8, q: query.value.q || undefined },
    signal, cache: 'no-store', throwOnError: true,
  })).data.data, () => emit('denied'));
defineExpose({ refresh });
const items = computed(() => result.value?.items ?? []);
const canSelect = (row: Registration) => !props.forNotice || activeRegistrationStatuses.includes(row.status);
const eligible = computed(() => items.value.filter(canSelect));
const allSelected = computed(() => eligible.value.length > 0 && eligible.value.every((r) => selected.value.has(r.student_id)));

function find() {
  const q = search.value.trim();
  if (q === query.value.q && query.value.page === 1) return void refresh();
  if (!props.forNotice && q !== query.value.q && studentIds.value.length) {
    studentIds.value = [];
    selectionNotice.value = '搜索条件已变更，已清空选择。';
  }
  query.value = { q, page: 1 };
}
function toggle(ids: string[], event: Event) {
  selectionNotice.value = '';
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(studentIds.value);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  studentIds.value = [...next];
}
</script>

<template>
  <div class="page-actions roster-search">
    <input
      type="search"
      aria-label="搜索报名人员"
      placeholder="姓名或学号"
      v-model="search"
      @keydown.enter.prevent="find"
    />
    <button type="button" @click="find">搜索</button>
  </div>
  <div class="page-actions">
    <span role="status" class="state-chip neutral">已选 {{ studentIds.length }} 人</span>
    <button v-if="studentIds.length" class="quiet" type="button" @click="studentIds = []">清空选择</button>
  </div>
  <p v-if="selectionNotice" role="status">{{ selectionNotice }}</p>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="refresh()">重读名单</button></p>
  <p v-else-if="!result" role="status">正在读取报名名单…</p>
  <p v-else-if="!result.total" role="status">未找到报名人员。</p>
  <div v-if="items.length" class="choices">
    <label class="select-page">
      <input
        type="checkbox"
        :checked="allSelected"
        :disabled="!eligible.length"
        :indeterminate="!allSelected && eligible.some((r) => selected.has(r.student_id))"
        @change="toggle(eligible.map((r) => r.student_id), $event)"
      />
      选择本页
    </label>
    <label v-for="row in items" :key="row.student_id">
      <input type="checkbox" :disabled="!canSelect(row) && !selected.has(row.student_id)" :checked="selected.has(row.student_id)" @change="toggle([row.student_id], $event)" />
      <span>{{ row.student_name }} <small>{{ row.student_no }}</small></span>
    </label>
  </div>
  <Pager v-if="result && result.total > result.page_size" :page="query.page" :size="result.page_size"
    :total="result.total" @change="query = { ...query, page: $event }" />
</template>

<style scoped>
.roster-search {
  margin-bottom: 8px;
}
.roster-search input {
  flex: 1;
  min-width: 0;
}
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr));
  margin-top: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.choices label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 10px;
  cursor: pointer;
}
.choices label:has(input:checked) {
  background: var(--brand-tint);
}
.choices .select-page {
  grid-column: 1 / -1;
  border-bottom: 1px solid var(--line);
}
.choices small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
</style>
