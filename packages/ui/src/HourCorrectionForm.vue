<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ApiError, createCommand, createHourCorrectionGroup, listActivityHours, listActivityRevisions,
  type HourCorrectionGroup, type HourCorrectionGroupInput, type HourRekeyItemInput,
} from '@hongyan/contracts';
import ActivityChoice from './ActivityChoice.vue';
import Pager from './Pager.vue';
import { message, noAccess, usePageRead } from './usePageRead';

const props = defineProps<{ activityId?: string; admin: boolean; disabled?: boolean }>();
const emit = defineEmits<{ saved: [HourCorrectionGroup]; denied: [] }>();
const route = useRoute();
const sourceActivity = ref(props.activityId ?? ''), targetActivity = ref(props.activityId ?? '');
const sourceDay = ref(typeof route.query.source_date === 'string' ? route.query.source_date : '');
const sourceRecord = ref(typeof route.query.source_record === 'string' ? route.query.source_record : '');
const targetDay = ref(sourceDay.value), sourcePage = ref(1), revisionPage = ref(1);
const size = 20;
const { data: source, error: sourceError, refresh: refreshSource } = usePageRead(
  () => [sourceActivity.value, sourceDay.value, sourcePage.value],
  async (signal) => sourceActivity.value ? (await listActivityHours({
    path: { id: sourceActivity.value }, query: { page: sourcePage.value, page_size: size,
      ...(sourceDay.value && { from_date: sourceDay.value, to_date: sourceDay.value }) },
    signal, throwOnError: true,
  })).data.data : undefined,
);
const { data: revisions, error: revisionError, refresh: refreshRevisions } = usePageRead(
  () => [targetActivity.value, revisionPage.value],
  async (signal) => targetActivity.value ? (await listActivityRevisions({
    path: { id: targetActivity.value }, query: { page: revisionPage.value, page_size: size }, signal, throwOnError: true,
  })).data.data : undefined,
);
const approved = computed(() => revisions.value?.items.filter((row) => row.revision_state === 'approved') ?? []);
const sourceRow = computed(() => source.value?.items.find((row) => row.id === sourceRecord.value));
const targetRevision = ref<number | ''>(''), studentNo = ref(''), studentName = ref(''), value = ref(''), itemReason = ref('');
const targetSelected = computed(() => targetRevision.value !== '' && !!targetActivity.value && !!targetDay.value);
watch([sourceActivity, sourceDay], () => { sourcePage.value = 1; sourceRecord.value = ''; });
watch(targetActivity, () => { revisionPage.value = 1; targetRevision.value = ''; });
watch(approved, (items) => {
  if (items.length && targetRevision.value === '') targetRevision.value = items[0].revision;
});
watch(sourceRow, (row) => {
  if (!row) return;
  if (!targetDay.value) targetDay.value = row.service_date;
  value.value = row.credited_hours;
});

const items = ref<{ label: string; item: HourRekeyItemInput }[]>([]);
const reason = ref(''), issue = ref(''), draftError = ref(''), busy = ref(false);
const command = createCommand();
function add() {
  draftError.value = '';
  const row = sourceRow.value;
  if (!row || !targetSelected.value || !itemReason.value.trim() || !studentName.value.trim()) {
    draftError.value = '请选择源记录、获批安排并补齐目标信息。';
    return;
  }
  if (items.value.some(({ item }) => item.source_record_id === row.id ||
    (item.target_student_no === studentNo.value && item.target_activity_id === targetActivity.value && item.target_service_date === targetDay.value))) {
    draftError.value = '源记录和目标键在组内均须唯一。';
    return;
  }
  items.value.push({
    label: (row.student_name ?? row.student_no ?? '学生') + ' · ' + row.activity_code + ' · ' + row.service_date + ' · ' + row.credited_hours + ' 小时',
    item: { source_record_id: row.id, expected_source_version: row.version, target_student_no: studentNo.value,
      target_student_name: studentName.value.trim(), target_activity_id: targetActivity.value,
      target_service_date: targetDay.value, target_schedule_revision: Number(targetRevision.value),
      credited_hours: value.value, reason: itemReason.value.trim() },
  });
  sourceRecord.value = ''; studentNo.value = ''; studentName.value = ''; itemReason.value = '';
}
async function submit() {
  if (!items.value.length || busy.value || props.disabled || !reason.value.trim()) return;
  const body: HourCorrectionGroupInput = {
    items: items.value.map(({ item }) => item), reason: reason.value.trim(),
    ...(typeof route.query.appeal_id === 'string' && { appeal_id: route.query.appeal_id }),
  };
  busy.value = true; issue.value = '';
  try {
    const { data } = await createHourCorrectionGroup({ body, throwOnError: true,
      headers: command.headers('create_hour_correction_group', props.activityId ?? 'admin', body) });
    command.confirmed();
    emit('saved', data.data);
  } catch (error) {
    issue.value = message(error);
    if (noAccess(error)) emit('denied');
    else if (error instanceof ApiError && error.status === 409) {
      command.confirmed();
      await refreshSource();
    }
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="correction-write">
    <h2>提交错账修复组</h2>
    <form class="pair-form" @submit.prevent="add">
      <fieldset :disabled="busy || disabled || items.length >= 100">
        <legend>添加一对源账与目标</legend>
        <div class="pair-grid">
          <div>
            <h3>撤销这笔账</h3>
            <ActivityChoice v-model="sourceActivity" :scope="admin ? 'all' : 'managed'" label="源活动" initial-label="当前活动" />
            <label>源服务日期<input type="date" v-model="sourceDay" /></label>
            <label>源时长记录
              <select v-model="sourceRecord" required>
                <option value="">选择一条有效记录</option>
                <option v-for="row in source?.items" :key="row.id" :value="row.id">
                  {{ row.student_name }} · {{ row.student_no }} · {{ row.service_date }} · {{ row.credited_hours }} 小时
                </option>
              </select>
            </label>
            <p v-if="sourceError" role="alert">{{ sourceError }} <button type="button" @click="refreshSource()">重读源台账</button></p>
            <p v-else-if="source && !source.total">所选活动与日期没有有效记录。</p>
            <Pager v-if="source && source.total > size" :page="sourcePage" :size="size" :total="source.total" @change="sourcePage = $event" />
          </div>
          <div>
            <h3>记入正确账目</h3>
            <ActivityChoice v-model="targetActivity" :scope="admin ? 'all' : 'managed'" label="目标活动" initial-label="当前活动" />
            <label>目标获批安排
              <select v-model="targetRevision" required>
                <option value="">选择获批版本</option>
                <option v-for="revision in approved" :key="revision.revision" :value="revision.revision">版本 {{ revision.revision }} · {{ revision.content.title }}</option>
              </select>
            </label>
            <p v-if="revisionError" role="alert">{{ revisionError }} <button type="button" @click="refreshRevisions()">重读获批安排</button></p>
            <Pager v-if="revisions && revisions.total > size" :page="revisionPage" :size="size" :total="revisions.total" @change="revisionPage = $event" />
            <div class="target-fields">
              <label>目标学号<input v-model="studentNo" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" required /></label>
              <label>目标姓名<input v-model="studentName" maxlength="100" required /></label>
              <label>目标服务日期<input v-model="targetDay" type="date" required /></label>
              <label>目标时长（小时）<input v-model="value" type="text" inputmode="decimal" pattern="(0\.[1-9]|[1-9][0-9]{0,2}(\.[0-9])?)" required /></label>
            </div>
          </div>
        </div>
        <label>该笔修复原因<textarea v-model="itemReason" rows="2" maxlength="2000" required /></label>
        <p v-if="draftError" role="alert">{{ draftError }}</p>
        <button type="submit" :disabled="!sourceRow || !targetSelected">加入修复组</button>
      </fieldset>
    </form>
    <form @submit.prevent="submit">
      <h3>已添加 {{ items.length }} / 100 对</h3>
      <ol class="pairs" v-if="items.length">
        <li v-for="{ item, label } in items" :key="item.source_record_id">
          <span>{{ label }} → {{ item.target_student_name }} · {{ item.target_student_no }} · {{ item.target_service_date }} · {{ item.credited_hours }} 小时</span>
          <button type="button" :disabled="busy || disabled" @click="items = items.filter(row => row.item.source_record_id !== item.source_record_id)">移除</button>
        </li>
      </ol>
      <label>整组修复原因<textarea v-model="reason" rows="2" maxlength="2000" :disabled="busy || disabled" required /></label>
      <p v-if="issue" role="alert">{{ issue }}</p>
      <button class="primary" type="submit" :disabled="!items.length || busy || disabled || !reason.trim()">提交修复组审核</button>
    </form>
  </section>
</template>
<style scoped>
.correction-write { max-width: 64rem; }
.pair-form fieldset { padding: 12px; margin: 16px 0; min-width: 0; border: 1px solid var(--line); }
.pair-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.target-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.correction-write label { display: grid; min-width: 0; gap: 4px; margin-block: 8px; }
.correction-write :is(input, select, textarea) { width: 100%; min-width: 0; }
.pairs li { margin-block: 8px; overflow-wrap: anywhere; }
.pairs button { margin-inline-start: 8px; }
@media (max-width: 760px) { .pair-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
