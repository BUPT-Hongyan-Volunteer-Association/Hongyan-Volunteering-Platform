<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import StatusFilter from '@hongyan/ui/StatusFilter.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import ExportButton from '@hongyan/ui/ExportButton.vue';
import { useIdSelection } from '@hongyan/ui/useSelection';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import { listStudents } from '@hongyan/contracts';

const route = useRoute(),
  router = useRouter();
const size = 20;
const search = ref('');
const page = computed(() => pageNumber(route.query.page));
const status = computed(
  () => String(route.query.status ?? 'all') as 'all' | 'active' | 'inactive',
);
const selectedGrade = computed(() => String(route.query.grade ?? 'all'));
const selectedCohort = computed(() => String(route.query.cohort ?? 'all'));
const { data, loading, error, refresh: load } = usePageRead(() => route.query, async signal =>
  (await listStudents({ query: {
    q: typeof route.query.q === 'string' ? route.query.q : undefined,
    cohort: selectedCohort.value === 'all' ? undefined : selectedCohort.value,
    grade: selectedGrade.value === 'all' ? undefined : selectedGrade.value,
    status: status.value === 'all' ? undefined : status.value,
    page: page.value, page_size: size,
  }, signal, throwOnError: true })).data.data);
const rows = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
watch(data, async result => {
  const focusId = window.history.state?.returnFocus;
  if (result && typeof focusId === 'string') {
    await nextTick();
    document.getElementById(focusId)?.focus();
  }
}, { once: true });
const {
  selected,
  pageIds: pageStudents,
  pageChecked,
  pageIndeterminate,
  togglePage,
  clear: clearSelection,
} = useIdSelection(() => rows.value.map((row) => row.id));
const exportInput = computed(() => ({
  type: 'admin_students' as const,
  q: route.query.q ? String(route.query.q) : undefined,
  cohort: route.query.cohort ? String(route.query.cohort) : undefined,
  grade: selectedGrade.value !== 'all' ? selectedGrade.value : undefined,
  account_status: status.value !== 'all' ? status.value : undefined,
}));
const selectedExportInput = computed(() => ({
  type: 'admin_students' as const,
  student_ids: [...selected.value],
}));
const cohortChoices = computed(() => [
  { value: 'all', label: '全部级部' },
  ...(data.value?.cohort_options ?? []).map((cohort) => ({ value: cohort, label: cohort })),
]);
const gradeChoices = computed(() => [
  { value: 'all', label: '全部年级' },
  ...(data.value?.grade_options ?? []).map((grade) => ({ value: grade, label: grade + '级' })),
]);

watch(() => route.query.q, q => { search.value = String(q ?? ''); }, { immediate: true });
function apply() {
  void router.push({
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(selectedCohort.value !== 'all' ? { cohort: selectedCohort.value } : {}),
      ...(selectedGrade.value !== 'all' ? { grade: selectedGrade.value } : {}),
      ...(status.value !== 'all' ? { status: status.value } : {}),
      page: 1,
    },
  });
}
function setFilter(field: 'cohort' | 'grade' | 'status', value: string) {
  void router.push({
    query: { ...route.query, [field]: value === 'all' ? undefined : value, page: 1 },
  });
}
watch(
  [
    () => route.query.q,
    () => route.query.cohort,
    () => route.query.grade,
    () => route.query.status,
  ],
  clearSelection,
);
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
    <div class="page-actions">
      <RouterLink class="button primary" to="/manage/imports">导入学生名单建档</RouterLink>
      <ExportButton :input="exportInput" :disabled="loading" @recheck="load()" />
      <ExportButton
        :input="selectedExportInput"
        :disabled="loading || !selected.size"
        :create-label="'导出所选学生' + (selected.size ? '（' + selected.size + '）' : '')"
        download-label="下载所选学生"
        @recheck="load()"
      />
    </div>
  </div>
  <form class="filter-bar" @submit.prevent="apply">
    <label>学号或姓名<input v-model="search" type="search" placeholder="输入学号或姓名" /></label>
    <label class="filter-select">级部
      <UiSelect :model-value="selectedCohort" label="级部" :options="cohortChoices" @update:model-value="setFilter('cohort', $event)" />
    </label>
    <label class="filter-select">年级
      <UiSelect :model-value="selectedGrade" label="年级" :options="gradeChoices" @update:model-value="setFilter('grade', $event)" />
    </label>
    <StatusFilter label="账号状态" :model-value="status" :options="{ all: '全部', active: '启用', inactive: '停用' }"
      @update:model-value="setFilter('status', $event)" />
    <button class="primary" type="submit">查询</button>
  </form>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="load()">重试读取</button></p>
  <p v-else-if="loading" role="status">正在读取学生档案…</p>
  <template v-else>
    <div v-if="rows.length" class="scroll-table">
      <table>
        <caption>学生档案</caption>
        <thead>
          <tr>
            <th scope="col" class="select-cell">
              <input
                v-if="pageStudents.length"
                type="checkbox"
                aria-label="选择本页学生"
                :checked="pageChecked"
                :indeterminate="pageIndeterminate"
                @change="togglePage(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th scope="col">学号</th>
            <th scope="col">姓名</th>
            <th scope="col">级部</th>
            <th scope="col">年级</th>
            <th scope="col">班级</th>
            <th scope="col">学院</th>
            <th scope="col">账号状态</th>
            <th scope="col">时长</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="student in rows" :key="student.id">
            <td class="select-cell">
              <input
                type="checkbox"
                :aria-label="'选择学生 ' + student.student_no"
                :value="student.id"
                v-model="selected"
              />
            </td>
            <th scope="row">{{ student.student_no }}</th>
            <td>{{ student.name }}</td>
            <td>{{ student.cohort || '—' }}</td>
            <td>{{ student.grade ? student.grade + '级' : '—' }}</td>
            <td>{{ student.class_name || '—' }}</td>
            <td>{{ student.college || '—' }}</td>
            <td>
              <span class="state-chip" :class="{ neutral: student.status !== 'active' }">
                {{ student.status === 'active' ? '启用' : '停用' }}
              </span>
              <RouterLink :id="'account-' + student.account_id" class="button compact account-link" :to="{ path: '/manage/accounts/' + student.account_id, query: { students: route.fullPath } }"
                :aria-label="'核对' + student.name + '的账号'">核对账号</RouterLink>
            </td>
            <td><RouterLink :id="'hours-' + student.id" class="button compact" :to="{ path: '/manage/students/' + student.id + '/hours', query: { name: student.name, students: route.fullPath } }">查看时长</RouterLink></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state">
      <p>没有匹配的学生档案</p>
    </div>
    <Pager v-if="data && total > data.page_size" :page="page" :size="data.page_size" :total="total" @change="goPage" />
  </template>
</template>

<style scoped>
.account-link { display: inline-block; margin-inline-start: 8px; white-space: nowrap; }
.filter-bar .filter-select {
  --select-width: 10rem;
}
.select-cell {
  width: 2.5rem;
}
</style>