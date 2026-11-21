<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ApiError, listActivityRegistrations, type ActivityRosterPage } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';

const props = defineProps<{ activityId: string }>();
const emit = defineEmits<{ denied: [] }>();
const studentIds = defineModel<string[]>({ required: true });
const selected = computed(() => new Set(studentIds.value));
const search = ref('');
const query = ref('');
const page = ref(1);
const result = ref<ActivityRosterPage>();
const error = ref('');
const items = computed(() => result.value?.items ?? []);
const allSelected = computed(() => items.value.length > 0 && items.value.every((r) => selected.value.has(r.student_id)));
let generation = 0;

async function load() {
  const turn = ++generation;
  error.value = '';
  result.value = undefined;
  try {
    const { data } = await listActivityRegistrations({
      path: { id: props.activityId },
      query: { scope: 'managed', page: page.value, page_size: 8, q: query.value || undefined },
      cache: 'no-store',
      throwOnError: true,
    });
    if (turn === generation) result.value = data.data;
  } catch (e) {
    if (turn !== generation) return;
    error.value = e instanceof Error ? e.message : '报名名单读取失败';
    if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0)) {
      studentIds.value = [];
      emit('denied');
    }
  }
}
function find() {
  const next = search.value.trim();
  if (next === query.value && page.value === 1) return void load();
  query.value = next;
  page.value = 1;
}
function toggle(ids: string[], event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(studentIds.value);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  studentIds.value = [...next];
}
watch([query, page], load, { immediate: true });
onUnmounted(() => generation++);
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
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重读名单</button></p>
  <p v-else-if="!result" role="status">正在读取报名名单…</p>
  <p v-else-if="!result.total" role="status">未找到报名人员。</p>
  <div v-if="items.length" class="choices">
    <label class="select-page">
      <input
        type="checkbox"
        :checked="allSelected"
        :indeterminate="!allSelected && items.some((r) => selected.has(r.student_id))"
        @change="toggle(items.map((r) => r.student_id), $event)"
      />
      选择本页
    </label>
    <label v-for="row in items" :key="row.student_id">
      <input type="checkbox" :checked="selected.has(row.student_id)" @change="toggle([row.student_id], $event)" />
      <span>{{ row.student_name }} <small>{{ row.student_no }}</small></span>
    </label>
  </div>
  <Pager v-if="result && result.total > result.page_size" :page="page" :size="result.page_size"
    :total="result.total" @change="page = $event" />
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
