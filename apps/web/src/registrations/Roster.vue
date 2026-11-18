<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { type Registration, type ActivityRosterPage } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
const route = useRoute(),
  q = ref(''),
  state = ref('submitted'),
  page = ref(1),
  selected = ref(new Set<string>()),
  notice = ref('');
const labels = {
  submitted: '待处理',
  accepted: '已录取',
  waitlisted: '候补',
  rejected: '未录取',
  withdrawn: '已撤回',
  exited: '已退出',
};
const samples = computed(() =>
  Array.from(
    { length: 36 },
    (_, i) =>
      ({
        id: '10000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
        version: 1,
        activity_id: String(route.params.id),
        student_id: '20000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
        student_no: String(i + 1).padStart(10, '0'),
        student_name: '示例志愿者 ' + (i + 1),
        submitted_at: '2026-11-18T09:00:00+08:00',
        status:
          i < 9
            ? 'submitted'
            : i < 27
              ? 'accepted'
              : i < 30
                ? 'waitlisted'
                : i < 33
                  ? 'rejected'
                  : i < 35
                    ? 'withdrawn'
                    : 'exited',
      }) satisfies Registration,
  ),
);
const result = computed<ActivityRosterPage>(() => {
  const found = samples.value.filter((r) => (r.student_name + r.student_no).includes(q.value));
  const counts = { submitted: 0, accepted: 0, waitlisted: 0, rejected: 0, withdrawn: 0, exited: 0 };
  for (const row of found) counts[row.status]++;
  const matches = found.filter((r) => !state.value || r.status === state.value);
  return {
    items: matches.slice((page.value - 1) * 5, page.value * 5),
    page: page.value,
    page_size: 5,
    total: matches.length,
    status_counts: counts,
    capacity: 30,
    accepted_count: 18,
  };
});
function clear() {
  notice.value = selected.value.size ? '筛选或活动已变更，已清空选择。' : '';
  selected.value.clear();
  page.value = 1;
}
watch([q, state], clear);
function toggleAll(checked: boolean) {
  for (const r of result.value.items)
    if (checked) selected.value.add(r.id);
    else selected.value.delete(r.id);
}
</script>
<template>
  <h1>报名名单</h1>
  <p>示例数据 · 录取决定待接入</p>
  <label>姓名或学号 <input v-model="q" /></label>
  <label
    >报名状态
    <select v-model="state">
      <option value="">
        全部 {{ Object.values(result.status_counts).reduce((a, b) => a + b, 0) }}
      </option>
      <option v-for="(v, k) in labels" :value="k">{{ v }} {{ result.status_counts[k] }}</option>
    </select></label
  >
  <p>已占 {{ result.accepted_count }}/{{ result.capacity }} · 已选 {{ selected.size }} 人</p>
  <p role="status">{{ notice }}</p>
  <div class="scroll-table">
    <table>
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              aria-label="选择本页"
              :checked="result.items.length > 0 && result.items.every((r) => selected.has(r.id))"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
          </th>
          <th>姓名</th>
          <th>学号</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in result.items" :key="r.id">
          <td>
            <input
              type="checkbox"
              :aria-label="'选择' + r.student_name"
              :value="r.id"
              v-model="selected"
            />
          </td>
          <td>{{ r.student_name }}</td>
          <td>{{ r.student_no }}</td>
          <td>{{ labels[r.status] }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="!result.total">暂无匹配的报名</p>
  <Pager :page="page" :size="5" :total="result.total" @change="(p) => (page = p)" />
</template>
