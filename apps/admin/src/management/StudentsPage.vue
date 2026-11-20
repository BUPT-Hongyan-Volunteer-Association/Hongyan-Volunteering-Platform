<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { listStudents, type Student } from '@hongyan/contracts';

const route = useRoute(),
  router = useRouter();
const size = 20;
const search = ref('');
const cohort = ref('');
const rows = ref<Student[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
let serial = 0;

const page = computed(() => {
  const value = Number(route.query.page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const status = computed(
  () => String(route.query.status ?? 'all') as 'all' | 'active' | 'inactive',
);
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' },
] as const;

async function load() {
  const current = ++serial;
  loading.value = true;
  error.value = '';
  try {
    const result = (
      await listStudents({
        query: {
          ...(route.query.q ? { q: String(route.query.q) } : {}),
          ...(route.query.cohort ? { cohort: String(route.query.cohort) } : {}),
          ...(status.value !== 'all' ? { status: status.value } : {}),
          page: page.value,
          page_size: size,
        },
        throwOnError: true,
      })
    ).data.data;
    if (current !== serial) return;
    rows.value = result.items;
    total.value = result.total;
  } catch (reason) {
    if (current === serial) error.value = reason instanceof Error ? reason.message : '读取学生档案失败';
  } finally {
    if (current === serial) loading.value = false;
  }
}
watch(
  () => route.query,
  () => {
    search.value = String(route.query.q ?? '');
    cohort.value = String(route.query.cohort ?? '');
    return load();
  },
  { immediate: true },
);
function apply() {
  void router.push({
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(cohort.value.trim() ? { cohort: cohort.value.trim() } : {}),
      ...(status.value !== 'all' ? { status: status.value } : {}),
      page: 1,
    },
  });
}
function setStatus(value: string) {
  void router.push({
    query: { ...route.query, ...(value === 'all' ? { status: undefined } : { status: value }), page: 1 },
  });
}
function goPage(next: number) {
  void router.push({ query: { ...route.query, page: next } });
}
</script>

<template>
  <div class="page-heading">
    <div class="page-title">
      <h1>学生档案</h1>
      <span class="state-chip neutral">共 {{ total }} 人</span>
    </div>
  </div>
  <form class="filters" @submit.prevent="apply">
    <label>学号或姓名<input v-model="search" type="search" placeholder="输入学号或姓名" /></label>
    <label>级部<input v-model="cohort" type="search" placeholder="按级部筛选" /></label>
    <label class="status-filter">账号状态
      <UiSelect :model-value="status" label="账号状态" :options="statusOptions" @update:model-value="setStatus" />
    </label>
    <button class="primary" type="submit">查询</button>
  </form>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试读取</button></p>
  <p v-else-if="loading" role="status">正在读取学生档案…</p>
  <template v-else>
    <div v-if="rows.length" class="scroll-table">
      <table>
        <caption>学生档案</caption>
        <thead>
          <tr>
            <th scope="col">学号</th>
            <th scope="col">姓名</th>
            <th scope="col">级部</th>
            <th scope="col">年级</th>
            <th scope="col">班级</th>
            <th scope="col">账号状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="student in rows" :key="student.id">
            <th scope="row">{{ student.student_no }}</th>
            <td>{{ student.name }}</td>
            <td>{{ student.cohort || '—' }}</td>
            <td>{{ student.grade || '—' }}</td>
            <td>{{ student.class_name || '—' }}</td>
            <td>
              <span class="state-chip" :class="{ neutral: student.status !== 'active' }">
                {{ student.status === 'active' ? '启用' : '停用' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state">
      <p>没有匹配的学生档案</p>
    </div>
    <Pager v-if="total > size" :page="page" :size="size" :total="total" @change="goPage" />
  </template>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 18px;
}
.filters label {
  display: grid;
  gap: 5px;
  font-size: 14px;
  color: var(--muted);
  min-width: 0;
}
.filters .status-filter {
  --select-width: 10rem;
}
</style>
