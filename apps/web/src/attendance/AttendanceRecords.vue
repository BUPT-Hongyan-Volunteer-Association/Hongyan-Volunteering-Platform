<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ApiError,
  createCommand,
  listAttendance,
  recordAttendance,
  recordAttendanceBatch,
  withdrawAttendance,
  type Attendance,
  type AttendancePage,
  type AttendanceStatus,
  type AttendanceStudentIdentity,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import RecordTable from '@hongyan/ui/RecordTable.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import type { PreviewRecord } from '@hongyan/ui/preview';
import AttendanceRoster from './AttendanceRoster.vue';

const props = defineProps<{ writesPaused: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const path = { id: String(useRoute().params.id) };
const labels: Record<AttendanceStatus, string> = {
  late: '迟到', absent: '缺席', excused: '请假', other: '自定义', unregistered_participation: '未报名参加',
};
const options = Object.entries(labels).map(([value, label]) => ({ value: value as AttendanceStatus, label }));
const filterDate = ref('');
const page = ref(1);
const result = ref<AttendancePage>();
const readError = ref('');
const notice = ref('');
const visibleForm = ref(false);
const editing = ref<Attendance>();
const serviceDate = ref('');
const status = ref<AttendanceStatus>('late');
const reason = ref('');
const selected = ref<string[]>([]);
const blankIdentity = () => ({ student_no: '', student_name: '' });
const identities = ref<AttendanceStudentIdentity[]>([]);
const writeError = ref('');
const saving = ref(false);
const stale = ref(false);
const accessLost = ref(false);
const locked = computed(() => saving.value || props.writesPaused || stale.value || accessLost.value);
const needsReason = computed(() => status.value === 'other' || status.value === 'unregistered_participation');
const records = computed<PreviewRecord[]>(() => (result.value?.items ?? []).map((row) => ({
  id: row.id,
  title: row.student_name,
  status: labels[row.status],
  fields: [['学号', row.student_no], ['服务日期', row.service_date], ['记录说明', row.reason ?? '—']],
})));
const command = createCommand();
let generation = 0;
let mounted = true;

function isDenied(e: unknown) {
  return e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0);
}
function denied() {
  generation++;
  accessLost.value = true;
  result.value = undefined;
  visibleForm.value = false;
  editing.value = undefined;
  selected.value = [];
  identities.value = [];
  reason.value = '';
  notice.value = '';
  emit('denied');
}

async function load() {
  const turn = ++generation;
  readError.value = '';
  result.value = undefined;
  try {
    const { data } = await listAttendance({
      path,
      query: { page: page.value, page_size: 10, service_date: filterDate.value || undefined },
      cache: 'no-store',
      throwOnError: true,
    });
    if (turn !== generation) return;
    const lastPage = Math.max(1, Math.ceil(data.data.total / data.data.page_size));
    if (page.value > lastPage) {
      page.value = lastPage;
      return;
    }
    accessLost.value = false;
    result.value = data.data;
  } catch (e) {
    if (turn !== generation) return;
    readError.value = e instanceof Error ? e.message : '现场异常读取失败';
    if (isDenied(e)) denied();
  }
}
function filter(date: string) {
  filterDate.value = date;
  page.value = 1;
}
function openForm(row?: Attendance) {
  editing.value = row;
  serviceDate.value = row?.service_date ?? filterDate.value;
  status.value = row?.status ?? 'late';
  reason.value = row?.reason ?? '';
  selected.value = [];
  identities.value = [blankIdentity()];
  stale.value = false;
  writeError.value = '';
  notice.value = '';
  visibleForm.value = true;
}
function edit(id: string) {
  const row = result.value?.items.find((record) => record.id === id);
  if (row) openForm(row);
}
function reloadAfterConflict() {
  visibleForm.value = false;
  void load();
}

async function save(withdraw = false) {
  if (locked.value) return;
  saving.value = true;
  writeError.value = '';
  const fields = { status: status.value, reason: reason.value.trim() || undefined };
  const row = editing.value;
  const day = serviceDate.value;
  try {
    if (row) {
      const recordPath = { ...path, service_date: row.service_date, student_id: row.student_id };
      const target = [path.id, row.student_id, row.service_date].join('/');
      const version = { expected_version: row.version };
      if (withdraw) {
        await withdrawAttendance({ path: recordPath, body: version,
          headers: command.headers('withdraw_attendance', target, version), throwOnError: true });
        notice.value = '已撤销现场异常记录。';
      } else {
        const body = { ...version, ...fields };
        await recordAttendance({ path: recordPath, body,
          headers: command.headers('record_attendance', target, body), throwOnError: true });
        notice.value = '已保存修改。';
      }
    } else {
      const students = status.value === 'unregistered_participation'
        ? { unregistered_students: identities.value.map(({ student_name, student_no }) => ({ student_name: student_name.trim(), student_no: student_no.trim() })) }
        : { student_ids: [...selected.value].sort() };
      const body = { service_date: day, ...fields, ...students };
      const { data } = await recordAttendanceBatch({ path, body,
        headers: command.headers('record_attendance_batch', path.id, body), throwOnError: true });
      notice.value = `已登记 ${data.data.recorded_count} 条现场异常。`;
    }
    command.confirmed();
    if (!mounted || accessLost.value) return;
    visibleForm.value = false;
    if (!row && (day !== filterDate.value || page.value !== 1)) filter(day);
    else await load();
  } catch (e) {
    if (!mounted) return;
    if (isDenied(e)) {
      readError.value = e instanceof Error ? e.message : '活动管理权限已失效';
      denied();
      return;
    }
    writeError.value = e instanceof Error ? e.message : '现场异常保存失败';
    stale.value = !!row && e instanceof ApiError && e.body?.code === 'version_conflict';
  } finally {
    saving.value = false;
  }
}

watch([filterDate, page], load, { immediate: true });
onUnmounted(() => {
  mounted = false;
  generation++;
});
</script>

<template>
  <section class="reading-area" aria-labelledby="attendance-heading">
    <header class="page-heading attendance-heading">
      <h2 id="attendance-heading">现场人员记录</h2>
      <button v-if="!visibleForm" class="primary" :disabled="writesPaused || accessLost" @click="openForm()">登记异常</button>
    </header>

    <form v-if="visibleForm" class="attendance-form" @submit.prevent="save()">
      <h3>{{ editing ? '修改记录' : '批量登记' }}</h3>
      <p v-if="editing">{{ editing.student_name }} · {{ editing.student_no }} · {{ editing.service_date }}</p>
      <fieldset :disabled="locked">
        <div class="date-and-status">
          <label v-if="!editing">登记服务日期<input type="date" required v-model="serviceDate" /></label>
          <label v-if="editing?.status !== 'unregistered_participation'">异常类型
            <UiSelect label="异常类型" v-model="status" :disabled="locked"
              :options="editing ? options.filter((choice) => choice.value !== 'unregistered_participation') : options" />
          </label>
          <p v-else>未报名参加</p>
        </div>
        <fieldset v-if="!editing && status !== 'unregistered_participation'" class="person-fieldset">
          <legend>报名人员</legend>
          <AttendanceRoster v-model="selected" :activity-id="path.id" @denied="denied" />
        </fieldset>
        <fieldset v-else-if="!editing" class="person-fieldset">
          <legend>未报名人员</legend>
          <div v-for="(person, i) in identities" :key="i" class="identity-row">
            <label>学号<input v-model.trim="person.student_no" required inputmode="numeric" maxlength="10" pattern="[0-9]{10}" /></label>
            <label>姓名<input v-model.trim="person.student_name" required /></label>
            <button v-if="identities.length > 1" type="button" class="quiet"
              :aria-label="`移除第 ${i + 1} 位人员`" @click="identities.splice(i, 1)">移除</button>
          </div>
          <button type="button" @click="identities.push(blankIdentity())">添加人员</button>
        </fieldset>
        <label class="reason-field">{{ needsReason ? '异常原因（必填）' : '记录说明（选填）' }}
          <textarea v-model="reason" :required="needsReason" maxlength="1000" rows="2" />
        </label>
      </fieldset>
      <p v-if="writeError" role="alert" class="save-error">{{ writeError }}
        <button v-if="stale" type="button" @click="reloadAfterConflict">刷新记录复核</button>
      </p>
      <div class="page-actions">
        <button class="primary" :disabled="locked || (needsReason && !reason.trim()) || (!editing && status !== 'unregistered_participation' && !selected.length)">
          {{ saving ? '正在保存…' : editing ? '保存修改' : '保存记录' }}
        </button>
        <button type="button" :disabled="saving" @click="visibleForm = false">取消</button>
        <button v-if="editing" type="button" :disabled="locked" class="quiet withdraw" @click="save(true)">撤销记录</button>
      </div>
    </form>

    <template v-else>
      <div class="page-actions filters">
        <label>服务日期 <input type="date" :value="filterDate" @change="filter(($event.target as HTMLInputElement).value)" /></label>
        <button v-if="filterDate" type="button" class="quiet" @click="filter('')">查看全部日期</button>
        <span v-if="result" class="state-chip neutral">共 {{ result.total }} 条异常</span>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="readError" role="alert">{{ readError }} <button @click="load">重读记录</button></p>
      <p v-else-if="!result" role="status">正在读取现场异常…</p>
      <p v-else-if="!result.total" role="status">{{ filterDate ? '该日期暂无现场异常。' : '本活动暂无现场异常。' }}</p>
      <RecordTable :records="records" label="现场人员记录" heading="姓名" status-heading="异常类型">
        <template #actions="{ id }">
          <button type="button" :disabled="writesPaused || accessLost" @click="edit(id)">修改</button>
        </template>
      </RecordTable>
      <Pager v-if="result && result.total > result.page_size" :page="page" :size="result.page_size"
        :total="result.total" @change="page = $event" />
    </template>
  </section>
</template>

<style scoped>
.attendance-heading {
  margin-bottom: 14px;
}
.filters {
  margin-bottom: 12px;
}
.filters label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.attendance-form {
  max-width: 42rem;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.attendance-form fieldset {
  display: grid;
  gap: 14px;
  min-inline-size: 0;
  margin: 0 0 14px;
  padding: 0;
  border: 0;
}
.date-and-status,
.identity-row {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px 14px;
}
.date-and-status label,
.identity-row label,
.reason-field {
  display: grid;
  gap: 4px;
  font-size: 14px;
}
.identity-row label {
  flex: 1 1 9rem;
  min-width: 0;
}
.person-fieldset legend {
  padding: 0 0 6px;
  font-weight: 600;
}
.attendance-form .person-fieldset {
  display: block;
  margin-bottom: 0;
}
.identity-row {
  margin-bottom: 8px;
}
.save-error,
.withdraw {
  color: var(--danger);
}
</style>
