<script setup lang="ts">
import { ref } from 'vue';
import { getHourBatchRows, type GetHourBatchRowsData } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { actions, fields, signed, useHourRead } from './display';

const props = defineProps<{ batchId:string }>();
const emit = defineEmits<{ denied:[] }>();
type Action = NonNullable<GetHourBatchRowsData['query']>['action'];
const action = ref<NonNullable<Action>|'all'>('all'), needsReview = ref(false), page = ref(1);
const size = 20;
const heading = ref<HTMLHeadingElement>();
function showErrors() {
  page.value = 1;
  needsReview.value = false;
  action.value = 'error';
  heading.value?.focus();
}
defineExpose({ showErrors });
const filters = [{value:'all',label:'全部动作'},...(['add','correct','skip_identical','error','void'] as const).map((value) => ({value,label:actions[value]}))];
const {data,error,loading,refresh} = useHourRead(() => [props.batchId,page.value,action.value,needsReview.value],async (signal) => {
  return (await getHourBatchRows({path:{id:props.batchId},query:{page:page.value,page_size:size,
      action:action.value === 'all' ? undefined : action.value, misconduct_requires_review:needsReview.value || undefined},
      signal,throwOnError:true})).data.data;
}, () => emit('denied'));
</script>
<template>
  <section>
    <h3 ref="heading" tabindex="-1">逐行核对</h3>
    <div class="filters">
      <label>行处理方式<UiSelect label="行处理方式" :model-value="action" :options="filters"
        @update:model-value="(next) => { page=1; action=next as typeof action }" /></label>
      <label><input v-model="needsReview" type="checkbox" @change="page=1" />只看违纪待核实行</label>
    </div>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重读明细</button></p>
    <p v-else-if="loading" role="status">正在读取原表明细…</p>
    <p v-else-if="!data?.total">当前条件下没有明细。</p>
    <template v-else>
      <div class="scroll-table" tabindex="0" aria-label="原表明细，可横向滚动">
        <table>
          <thead><tr><th>原表行号</th><th>学生 / 学号</th><th>动作与错误</th><th>服务日期 / 活动</th><th>原值 → 新值 / 差额（小时）</th><th>时长警告</th><th>违纪上报</th><th>备注 / 安排</th></tr></thead>
          <tbody><tr v-for="row in data.items" :key="row.row_number">
            <th scope="row">第 {{ row.row_number }} 行</th>
            <td>{{ row.student_name || row.raw_values?.student_name || '—' }}<small>{{ row.student_no || row.raw_values?.student_no || '—' }}</small></td>
            <td><strong>{{ actions[row.action] }}</strong>
              <p v-for="issue in row.errors" :key="issue.field+issue.message" class="row-error">{{ fields[issue.field ?? ''] ?? issue.field }}：{{ issue.message }}</p>
            </td>
            <td>{{ row.service_date || row.raw_values?.service_date || '—' }}<small>{{ row.activity_code || row.raw_values?.activity_code || '—' }}</small></td>
            <td>{{ row.previous_hours ?? '—' }} → {{ row.credited_hours ?? row.raw_values?.credited_hours ?? '—' }}<small>差额 {{ signed(row.delta_hours) }}</small></td>
            <td><p v-for="warning in row.warnings" :key="warning.warning_id">{{ warning.message }}
              <small v-if="warning.projected_daily_hours">当日预计 {{ warning.projected_daily_hours }} 小时</small>
              <small v-if="warning.planned_hours">计划覆盖 {{ warning.planned_hours }} 小时</small>
              <small>{{ warning.explanation ? '说明：' + warning.explanation : '须在工作簿备注中补充说明' }}</small></p><span v-if="!row.warnings?.length">—</span></td>
            <td>{{ row.misconduct_reported === 'reported' ? '有' : row.misconduct_reported === 'none' ? '无' : row.misconduct_reported === 'not_provided' ? '未提供' : row.raw_values?.misconduct_reported || '未填写' }}<small v-if="row.misconduct_requires_review">待核实</small></td>
            <td>{{ row.remark || row.raw_values?.remark || '—' }}<small v-if="row.bound_schedule_revision">获批版本 {{ row.bound_schedule_revision }}</small></td>
          </tr></tbody>
        </table>
      </div>
      <p>当前条件共 {{ data.total }} 行</p>
      <Pager v-if="data.total > size" :page="page" :size="size" :total="data.total" @change="(next) => page=next" />
    </template>
  </section>
</template>
<style scoped>
.filters { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-bottom:12px; }
.filters label { display:flex; align-items:center; gap:6px; }
.scroll-table table { min-width:1080px; }
.scroll-table td { white-space:normal; overflow-wrap:anywhere; vertical-align:top; max-width:240px; }
.scroll-table tbody th { vertical-align:top; }
.scroll-table tr > th:first-child { z-index:1; border-right:1px solid var(--line); }
small { display:block; color:var(--muted); }
td p { margin:0 0 5px; }
.row-error { color:#942f27; }
</style>
