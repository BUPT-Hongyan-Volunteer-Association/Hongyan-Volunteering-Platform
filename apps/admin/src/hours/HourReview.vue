<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { HourBatch, HourRow } from '@hongyan/contracts';
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
  result = ref('');
const inputs = reactive(
  Object.fromEntries(
    rows.map((r) => [batch.id + '/' + r.row_number, { decision: '', opinion: '' }]),
  ),
);
const filtered = computed(() => rows.filter((r) => !only.value || r.misconduct_requires_review));
watch(only, () => {
  page.value = 1;
});
function preview() {
  const missing = rows.filter(
    (r) =>
      r.misconduct_requires_review &&
      (!inputs[batch.id + '/' + r.row_number].decision ||
        !inputs[batch.id + '/' + r.row_number].opinion.trim()),
  );
  result.value = missing.length
    ? '请核实原表第 ' + missing.map((r) => r.row_number).join('、') + ' 行并填写意见'
    : batch.warnings.length && !reason.value.trim()
      ? '请填写警告接受依据'
      : '输入完整，可通过整批（预览）';
}
</script>
<template>
  <template v-if="!route.params.id"
    ><h1>时长审核</h1>
    <p>示例数据</p>
    <RouterLink :to="'/hours/' + batch.id"
      >{{ batch.batch_code }} · {{ batch.activity_title }}</RouterLink
    ></template
  >
  <template v-else
    ><RouterLink to="/hours">返回时长审核</RouterLink>
    <p v-if="route.params.id !== batch.id">批次不存在</p>
    <template v-else>
      <h1>时长批次审核</h1>
      <p>示例数据 · 处罚未启用</p>
      <p>{{ batch.batch_code }} · {{ batch.activity_title }} · {{ batch.source_file_name }}</p>
      <p>
        提交人 {{ batch.submitted_by_name }} · 送审时间
        {{ new Date(batch.submitted_at!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}
      </p>
      <p>全批 {{ batch.row_count }} 条 · 合计 {{ batch.projected_delta_hours }} 小时</p>
      <label><input type="checkbox" v-model="only" />只看待核实行</label>
      <div class="scroll-table">
        <table>
          <thead>
            <tr>
              <th
                v-for="label in [
                  '原表行',
                  '学号',
                  '姓名',
                  '活动编号',
                  '服务日期',
                  '认证时长（小时）',
                  '备注',
                  '是否有违纪情况',
                  '核实结论与意见',
                ]"
              >
                {{ label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in filtered.slice((page - 1) * 3, page * 3)" :key="r.row_number">
              <th>{{ r.row_number }}</th>
              <td>{{ r.student_no }}</td>
              <td>{{ r.student_name }}</td>
              <td>{{ r.activity_code }}</td>
              <td>{{ r.service_date }}</td>
              <td>{{ r.credited_hours }}</td>
              <td>{{ r.remark }}</td>
              <td>{{ r.misconduct_reported === 'reported' ? '有' : '无' }}</td>
              <td>
                <template v-if="r.misconduct_requires_review"
                  ><select
                    :aria-label="'第' + r.row_number + '行结论'"
                    v-model="inputs[batch.id + '/' + r.row_number].decision"
                  >
                    <option value="">请选择</option>
                    <option>属实</option>
                    <option>不成立</option>
                  </select>
                  <input
                    :aria-label="'第' + r.row_number + '行意见'"
                    v-model="inputs[batch.id + '/' + r.row_number].opinion"
                /></template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pager :page="page" :size="3" :total="filtered.length" @change="(p) => (page = p)" />
      <p>时长警告：{{ batch.warnings.length ? '待复核' : '无' }}</p>
      <label>整批意见 <input v-model="reason" /></label>
      <button @click="preview">预览通过整批</button>
      <p role="status">{{ result }}</p>
    </template></template
  >
</template>
