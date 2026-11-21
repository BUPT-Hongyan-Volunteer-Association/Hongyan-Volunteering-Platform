<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { HourBatch, HourRow } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import Pager from '@hongyan/ui/Pager.vue';
const route = useRoute();
const batch: HourBatch = {
  id: '30000000-0000-4000-8000-000000000001',
  version: 1,
  activity_id: '40000000-0000-4000-8000-000000000001',
  mode: 'new',
  status: 'pending_review',
  batch_code: 'H2026-001',
  activity_code: 'P2026-0001',
  activity_title: '校园服务甲',
  submitted_by: '50000000-0000-4000-8000-000000000001',
  submitted_by_name: '甲负责人',
  submitted_at: '2026-11-18T09:00:00+08:00',
  source_file_id: '60000000-0000-4000-8000-000000000001',
  source_file_name: '校园服务甲时长.xlsx',
  source_hash: 'a'.repeat(64),
  valid_count: 5,
  row_count: 5,
  template_structure: 'hours_misconduct_7',
  projected_delta_hours: '10.0',
  misconduct_review_required_count: 2,
  warnings: [],
  warning_snapshot_hash: 'b'.repeat(64),
};
const rows: HourRow[] = Array.from({ length: 5 }, (_, i) => ({
  row_number: i + 2,
  action: 'add',
  student_no: String(i + 1).padStart(10, '0'),
  student_name: '示例学生 ' + (i + 1),
  activity_code: batch.activity_code,
  service_date: '2026-11-17',
  credited_hours: '2.0',
  remark: i === 2 || i === 4 ? '未按时签到' : '',
  misconduct_reported: i === 2 || i === 4 ? 'reported' : 'none',
  misconduct_requires_review: i === 2 || i === 4,
}));
const only = ref(false),
  page = ref(1),
  reason = ref(''),
  warningBasis = ref(''),
  result = ref('');
const inputs = reactive(
  Object.fromEntries(
    rows.map((r) => [batch.id + '/' + r.row_number, { decision: '', opinion: '' }]),
  ),
);
const filtered = computed(() => rows.filter((r) => !only.value || r.misconduct_requires_review));
const pageSize = ref(5);
const activeRow = ref<number>();
const visibleRows = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
const active = computed(() =>
  visibleRows.value.find((r) => r.row_number === activeRow.value && r.misconduct_requires_review),
);
const activeInput = computed(() =>
  active.value ? inputs[batch.id + '/' + active.value.row_number] : undefined,
);
const submitted = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).format(new Date(batch.submitted_at!));
watch([only, pageSize], () => {
  page.value = 1;
});
watch(
  visibleRows,
  (list) => {
    if (!list.some((r) => r.row_number === activeRow.value))
      activeRow.value = list.find((r) => r.misconduct_requires_review)?.row_number;
  },
  { immediate: true },
);
watch(
  [inputs, reason, warningBasis],
  () => {
    result.value = '';
  },
  { deep: true },
);
function preview() {
  const missing = rows.filter(
    (r) =>
      r.misconduct_requires_review &&
      (!inputs[batch.id + '/' + r.row_number].decision ||
        !inputs[batch.id + '/' + r.row_number].opinion.trim()),
  );
  if (missing.length) {
    const first = missing[0];
    page.value = Math.floor(filtered.value.indexOf(first) / pageSize.value) + 1;
    activeRow.value = first.row_number;
  }
  result.value = missing.length
    ? '请核实原表第 ' + missing.map((r) => r.row_number).join('、') + ' 行并填写意见'
    : batch.warnings.length && !warningBasis.value.trim()
      ? '请填写警告接受依据'
      : '输入完整，可通过整批（预览）';
}
</script>
<template>
  <template v-if="!route.params.id">
    <div class="page-heading">
      <div class="page-title">
        <h1>时长审核</h1>
        <span class="sample-label">示例数据</span>
      </div>
    </div>
    <div class="entry-list reading-area">
      <RouterLink :to="'/hours/' + batch.id">
        <span class="item-icon"><UiIcon name="DocumentChecked" /></span>
        <div>
          <strong>{{ batch.batch_code }} · {{ batch.activity_title }}</strong
          ><small class="meta-line"
            >{{ batch.row_count }} 条 · 合计 {{ batch.projected_delta_hours }} 小时</small
          >
        </div>
        <span class="row-end"
          ><span class="state-chip attention">待审核</span><UiIcon name="ArrowRight"
        /></span>
      </RouterLink>
    </div>
  </template>
  <template v-else-if="route.params.id !== batch.id"
    ><RouterLink to="/hours">返回时长审核</RouterLink>
    <p>批次不存在</p></template
  >
  <article v-else class="hour-review">
    <header>
      <div class="page-title">
        <h1>时长批次审核</h1>
        <span class="state-chip attention">待审核</span>
      </div>
      <p class="batch-activity">{{ batch.activity_title }} · {{ batch.activity_code }}</p>
      <p class="batch-meta">
        {{ batch.batch_code }} · 新增导入 · 提交人 {{ batch.submitted_by_name }} · 送审
        {{ submitted }}
      </p>
      <p class="source-file"><UiIcon name="Paperclip" />源文件　{{ batch.source_file_name }}</p>
    </header>
    <div class="page-actions review-tools">
      <strong class="icon-label"
        ><UiIcon name="CircleCheck" />校验通过 · 新增 {{ batch.valid_count }} 条</strong
      ><span class="sample-label">示例数据</span>
      <label><input type="checkbox" v-model="only" />只看待核实行</label>
    </div>
    <div class="scroll-table data-grid">
      <table>
        <thead>
          <tr>
            <th
              v-for="h in [
                '原表行',
                '学号',
                '姓名',
                '活动编号',
                '服务日期',
                '认证时长（小时）',
                '备注',
                '是否有违纪情况',
              ]"
              :key="h"
            >
              {{ h }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in visibleRows"
            :key="r.row_number"
            :class="{ selected: active?.row_number === r.row_number }"
            @click="r.misconduct_requires_review && (activeRow = r.row_number)"
          >
            <th scope="row">
              <button
                v-if="r.misconduct_requires_review"
                :aria-label="'核实原表第' + r.row_number + '行'"
                :aria-pressed="active?.row_number === r.row_number"
                @click="activeRow = r.row_number"
              >
                {{ r.row_number }}</button
              ><span v-else>{{ r.row_number }}</span>
            </th>
            <td>{{ r.student_no }}</td>
            <td>{{ r.student_name }}</td>
            <td>{{ r.activity_code }}</td>
            <td>{{ r.service_date }}</td>
            <td>{{ r.credited_hours }}</td>
            <td>{{ r.remark || '—' }}</td>
            <td>
              <span :class="{ 'state-chip attention': r.misconduct_requires_review }">{{
                r.misconduct_reported === 'reported' ? '有' : '无'
              }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="page-actions table-end">
      <strong>全批 {{ batch.row_count }} 条 · 合计 {{ batch.projected_delta_hours }} 小时</strong>
      <label
        >每页
        <UiSelect
          label="每页"
          v-model="pageSize"
          :options="[
            { value: 3, label: '3 条' },
            { value: 5, label: '5 条' },
          ]"
      /></label>
      <Pager
        v-if="filtered.length > pageSize"
        :page="page"
        :size="pageSize"
        :total="filtered.length"
        @change="(p) => (page = p)"
      />
    </div>
    <section v-if="active && activeInput" class="verify">
      <div class="page-title">
        <h2>违纪核实</h2>
        <span class="state-chip">原表第 {{ active.row_number }} 行</span>
      </div>
      <p>
        <strong>{{ active.student_name }}</strong
        >（{{ active.student_no }}） · {{ active.remark }} <small>处罚未启用</small>
      </p>
      <fieldset>
        <legend>核实结论</legend>
        <label v-for="choice in ['属实', '不成立']" :key="choice"
          ><input type="radio" name="decision" :value="choice" v-model="activeInput.decision" />{{
            choice
          }}</label
        >
      </fieldset>
      <label class="opinion"
        >核实意见
        <input :aria-label="'第' + active.row_number + '行意见'" v-model="activeInput.opinion"
      /></label>
    </section>
    <p class="warning">时长警告 · {{ batch.warnings.length ? '待复核' : '无' }}</p>
    <label class="opinion" v-if="batch.warnings.length"
      >警告接受依据<input v-model="warningBasis"
    /></label>
    <footer>
      <label class="opinion">整批意见 <input v-model="reason" placeholder="批准时选填" /></label>
      <div class="page-actions decisions">
        <RouterLink class="button" to="/hours"><UiIcon name="ArrowLeft" />返回时长审核</RouterLink
        ><button class="primary" @click="preview"><UiIcon name="Check" />预览通过整批</button>
      </div>
      <p v-if="result" role="status">{{ result }}</p>
    </footer>
  </article>
</template>
<style scoped>
.table-end {
  --select-width: 5rem;
}
.source-file {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
}
.source-file .ui-icon,
.review-tools .ui-icon {
  color: var(--brand);
}
.verify {
  margin-top: 10px;
  padding-inline: 14px !important;
  background: var(--surface);
  border-left: 3px solid var(--yellow);
}
.verify fieldset label {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
}
.verify .opinion {
  margin-top: 5px;
}
@media (max-width: 700px) {
  .verify fieldset label {
    min-height: 44px;
  }
  .opinion input {
    width: 0;
  }
  .review-tools {
    gap: 6px;
  }
  .review-tools label {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
}
.hour-review {
  font-size: 14px;
}
.hour-review header,
.verify,
.table-end {
  border-bottom: 1px solid var(--line);
}
.batch-activity {
  font-size: 17px;
  font-weight: 600;
  margin: 8px 0 0;
}
.batch-meta,
.source-file {
  margin: 5px 0;
  color: var(--muted);
}
.source-file {
  margin-bottom: 13px;
}
.review-tools,
.table-end {
  padding: 10px 0;
}
.review-tools label,
.table-end label {
  margin-left: auto;
}
.sample-label {
  margin: 0;
}
.data-grid th,
.data-grid td {
  padding: 8px;
}
.data-grid tbody th button {
  padding: 2px 6px;
  color: var(--brand);
  font-weight: 600;
  background: white;
}
.data-grid tbody tr:has(button) {
  cursor: pointer;
}
.table-end :deep(.pager) {
  margin: 0;
}
.verify {
  padding: 12px 0;
}
.verify h2 {
  font-size: 18px;
}
.verify p {
  margin: 5px 0;
}
.verify small {
  background: var(--surface);
  color: var(--muted);
  padding: 3px 6px;
}
fieldset {
  display: flex;
  align-items: center;
  gap: 16px;
  border: 0;
  padding: 0;
  margin: 4px 0;
}
legend {
  float: left;
  margin: 4px 0 4px 0;
  color: var(--muted);
}
input[type='radio'],
input[type='checkbox'] {
  accent-color: var(--brand);
}
label.opinion {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 600;
}
.opinion input {
  flex: 1;
  min-width: 0;
  font-weight: 400;
}
.warning {
  font-size: 13px;
  color: var(--muted);
  margin: 8px 0;
}
.decisions {
  justify-content: flex-end;
  margin-top: 12px;
}
.decisions a {
  border: 1px solid #c6d3e4;
  border-radius: 6px;
  padding: 6px 12px;
  text-decoration: none;
}
</style>
