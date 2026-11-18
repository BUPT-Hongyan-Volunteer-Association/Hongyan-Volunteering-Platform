<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { type Registration, type ActivityRosterPage } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import Pager from '@hongyan/ui/Pager.vue';
const route = useRoute(),
  q = ref(''),
  state = ref('submitted'),
  page = ref(1),
  selected = ref(new Set<string>()),
  notice = ref(''),
  inspected = ref<Registration>();
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
const otherStates = computed(() => [
  { value: '', label: '其他状态', disabled: true },
  ...lessCommon.map((value) => ({
    value,
    label: labels[value] + ' ' + result.value.status_counts[value],
  })),
]);
function clear() {
  notice.value = selected.value.size ? '筛选或活动已变更，已清空选择。' : '';
  inspected.value = undefined;
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
  <div class="roster-heading">
    <div class="page-title">
      <h2>报名名单</h2>
      <span class="sample-label">示例数据</span>
    </div>
    <p class="capacity">
      <UiIcon name="User" /> 已占
      <strong>{{ result.accepted_count }} / {{ result.capacity }}</strong> 人
    </p>
  </div>
  <div class="status-filters" aria-label="报名状态">
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
      @update:model-value="state = $event"
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
    <button disabled class="primary" aria-label="录取所选（待接入）" aria-describedby="roster-note">
      <UiIcon name="Check" />录取所选<span v-if="selected.size">（{{ selected.size }}）</span>
    </button>
    <button disabled aria-label="设为候补（待接入）" aria-describedby="roster-note">设为候补</button
    ><button disabled aria-label="导出名单（待接入）" aria-describedby="roster-note">
      <UiIcon name="Download" />导出名单
    </button>
  </div>
  <p v-if="notice" role="status">{{ notice }}</p>
  <div class="scroll-table data-grid">
    <table>
      <thead>
        <tr>
          <th>
            <label class="check-cell">
              <input
                type="checkbox"
                aria-label="选择本页"
                :indeterminate="
                  result.items.some((r) => selected.has(r.id)) &&
                  !result.items.every((r) => selected.has(r.id))
                "
                :checked="result.items.length > 0 && result.items.every((r) => selected.has(r.id))"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
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
      ><small id="roster-note">录取、候补及导出待接入</small>
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
    </dl>
  </section>
</template>
<style scoped>
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
.sample-label {
  margin: 0;
  font-size: 12px;
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
