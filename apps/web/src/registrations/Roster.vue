<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  getActivityMembers,
  type Registration,
  type Profile,
  type ActivityRosterPage,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
const props = defineProps<{ profile: Profile }>();
const route = useRoute(),
  allowed = ref(false),
  error = ref(''),
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
let serial = 0;
async function authorize() {
  const n = ++serial;
  allowed.value = false;
  error.value = '';
  clear();
  try {
    const result = await getActivityMembers({
      path: { id: String(route.params.id) },
      throwOnError: true,
    });
    if (!result.data.data.items.some((m) => m.account_id === props.profile.account_id))
      throw Error('当前账号不在本活动管理团队');
    if (n === serial) allowed.value = true;
  } catch (e) {
    if (n === serial) error.value = e instanceof Error ? e.message : '访问失败';
  }
}
watch(() => route.params.id, authorize, { immediate: true });
function toggleAll(checked: boolean) {
  for (const r of result.value.items)
    if (checked) selected.value.add(r.id);
    else selected.value.delete(r.id);
}
</script>
<template>
  <RouterLink to="/managed">返回活动管理</RouterLink>
  <h1>报名名单</h1>
  <p v-if="error" role="alert">{{ error }} <button @click="authorize">重试</button></p>
  <p v-else-if="!allowed">正在核验访问权限…</p>
  <template v-else
    ><p>示例数据 · 录取决定待接入</p>
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
</template>
