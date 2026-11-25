<script setup lang="ts">
import { fileHash } from '@hongyan/ui/files';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import {
  ApiError,
  commitStudentImport,
  createCommand,
  getStudentImport,
  getStudentImportRows,
  retryStudentImportValidation,
  uploadStudentImport,
  type FieldError,
  type StudentImport,
  type StudentImportRow,
} from '@hongyan/contracts';
import templateUrl from '../../../../packages/contracts/templates/学生建档导入模板_v1.5.xlsx?url';

const route = useRoute(),
  router = useRouter(),
  command = createCommand();
const title = '建档导入';
const statusLabels = {
  validating: '正在校验',
  invalid: '内容有误',
  ready: '待确认',
  committed: '已建档',
  failed: '系统校验失败',
} as const;
const actionLabels = {
  create: '新建',
  skip_identical: '重复跳过',
  error: '错误',
} as const;
const picker = ref<HTMLInputElement>();
const chosenName = ref('');
const dragging = ref(false);
const batch = ref<StudentImport>();
const rows = ref<StudentImportRow[]>([]);
const rowTotal = ref(0);
const rowPage = ref(1);
const requestedRows = 100;
const rowSize = ref(requestedRows);
const rowFailure = ref<{ page: number; message: string }>();
let rowRequest = 0;
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const writeFailure = ref<{ message: string; details: FieldError[] }>();
let routeVersion = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let loadSerial = 0;
let disposed = false;
onUnmounted(() => {
  disposed = true;
  stopPolling();
});

const batchId = computed(() => (route.params.item ? String(route.params.item) : ''));
const sourceName = computed(() => batchId.value && typeof window.history.state?.importFilename === 'string'
  ? window.history.state.importFilename : '');
const statusText = computed(() => (batch.value ? statusLabels[batch.value.status] : ''));
const canCommit = computed(
  () =>
    !!batch.value &&
    batch.value.id === batchId.value &&
    batch.value.status === 'ready' &&
    batch.value.error_count === 0 &&
    rows.value.length > 0 &&
    !loading.value,
);

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试';
}
function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}
function display(
  row: StudentImportRow,
  field: 'student_no' | 'name' | 'cohort' | 'grade' | 'class_name' | 'college',
) {
  if (field === 'grade') {
    if (row.errors?.some(issue => issue.field === 'grade')) return row.raw_values?.grade || '—';
    if (row.grade) return row.grade + '级';
  }
  return row[field] || row.raw_values?.[field] || '—';
}
const showCohort = computed(() => rows.value.some(r => display(r, 'cohort') !== '—'));
const showCollege = computed(() => rows.value.some(r => display(r, 'college') !== '—'));
function currentRoute(version: number) {
  return !disposed && version === routeVersion;
}
function stillCurrent(id: string, serial: number) {
  return !disposed && serial === loadSerial && batchId.value === id;
}
async function loadRows(page: number, serial = loadSerial) {
  const current = batch.value;
  if (!current) return;
  const request = ++rowRequest;
  const isCurrent = () => request === rowRequest && stillCurrent(current.id, serial);
  rowFailure.value = undefined;
  try {
    const { data } = await getStudentImportRows({
      path: { id: current.id },
      query: { page, page_size: requestedRows },
      throwOnError: true,
    });
    if (!isCurrent()) return;
    rowPage.value = data.data.page;
    rowSize.value = data.data.page_size;
    rowTotal.value = data.data.total;
    rows.value = data.data.items;
  } catch (reason) {
    if (!isCurrent()) return;
    if (reason instanceof ApiError && [401, 403, 404].includes(reason.status ?? 0)) {
      batch.value = undefined;
      rows.value = [];
      writeFailure.value = undefined;
      error.value = message(reason);
    } else {
      rowFailure.value = { page, message: message(reason) };
    }
  }
}
async function loadBatch(id: string, { quiet = false } = {}) {
  const serial = ++loadSerial;
  error.value = '';
  rowFailure.value = undefined;
  if (!quiet) {
    loading.value = !!id;
    batch.value = undefined;
    rows.value = [];
    rowTotal.value = 0;
    rowPage.value = 1;
  }
  if (!id) return;
  try {
    const data = (await getStudentImport({ path: { id }, throwOnError: true })).data.data;
    if (!stillCurrent(id, serial)) return;
    batch.value = data;
    await loadRows(1, serial);
    if (!stillCurrent(id, serial)) return;
    if (batch.value && data.status === 'validating') schedulePoll();
    else stopPolling();
  } catch (reason) {
    if (stillCurrent(id, serial)) error.value = message(reason);
  } finally {
    if (stillCurrent(id, serial)) loading.value = false;
  }
}
function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(() => {
    const current = batch.value;
    if (current) void loadBatch(current.id, { quiet: true });
  }, 800);
}
function openPicker() {
  if (!busy.value) picker.value?.click();
}
function acceptFile(next: File | undefined) {
  error.value = '';
  if (!next || busy.value) return;
  if (!/\.xlsx$/i.test(next.name) || next.size > 5_242_880) {
    error.value = '请选择不超过 5 MB 的 .xlsx 学生建档模板';
    return;
  }
  chosenName.value = next.name;
  void uploadFile(next);
}
function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  acceptFile(input.files?.[0]);
  input.value = '';
}
function drop(event: DragEvent) {
  dragging.value = false;
  acceptFile(event.dataTransfer?.files?.[0]);
}
function dragOver() {
  if (!busy.value) dragging.value = true;
}
function dragLeave() {
  dragging.value = false;
}
async function uploadFile(source: File) {
  if (busy.value) return;
  const version = routeVersion;
  busy.value = true;
  error.value = '';
  writeFailure.value = undefined;
  notice.value = '';
  try {
    const hash = await fileHash(source);
    const headers = command.headers('upload_student_import', '', { file: [source.name, hash] });
    const result = await uploadStudentImport({
      body: { file: source },
      headers,
      throwOnError: true,
    });
    command.confirmed();
    if (!currentRoute(version)) return;
    chosenName.value = '';
    notice.value = '文件已受理，正在校验…';
    await router.replace({ path: '/manage/imports/' + result.data.data.id, state: { importFilename: source.name } });
  } catch (reason) {
    if (currentRoute(version)) error.value = message(reason);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function commit() {
  const current = batch.value;
  if (!current || !canCommit.value || busy.value) return;
  const version = routeVersion;
  busy.value = true;
  error.value = '';
  writeFailure.value = undefined;
  const body = { expected_version: current.version, source_hash: current.source_hash };
  try {
    const result = await commitStudentImport({
      path: { id: current.id },
      body,
      headers: command.headers('commit_student_import', current.id, body),
      throwOnError: true,
    });
    command.confirmed();
    if (!currentRoute(version)) return;
    batch.value = result.data.data;
    notice.value = '已确认建档，可在学生档案中查到新学生';
    await loadBatch(current.id, { quiet: true });
  } catch (reason) {
    if (!currentRoute(version)) return;
    const details = reason instanceof ApiError && reason.status === 409 ? reason.body?.details : undefined;
    writeFailure.value = { message: message(reason), details: details ?? [] };
    await loadBatch(current.id, { quiet: true });
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function retry() {
  const current = batch.value;
  if (!current || current.id !== batchId.value || busy.value) return;
  const version = routeVersion;
  busy.value = true;
  error.value = '';
  const body = { expected_version: current.version };
  try {
    const result = await retryStudentImportValidation({
      path: { id: current.id },
      body,
      headers: command.headers('retry_student_import_validation', current.id, body),
      throwOnError: true,
    });
    command.confirmed();
    if (!currentRoute(version)) return;
    batch.value = result.data.data;
    notice.value = '已重新排队校验…';
    schedulePoll();
  } catch (reason) {
    if (currentRoute(version)) error.value = message(reason);
  } finally {
    if (!disposed) busy.value = false;
  }
}
watch(
  batchId,
  (id) => {
    routeVersion++;
    stopPolling();
    notice.value = '';
    chosenName.value = '';
    writeFailure.value = undefined;
    void loadBatch(id);
  },
  { immediate: true },
);
</script>

<template>
  <div class="page-heading reading-area">
    <div class="page-title">
      <h1>{{ title }}</h1>
      <span v-if="batch" class="state-chip" :class="{
        attention: batch.status === 'invalid' || batch.status === 'failed',
        neutral: batch.status === 'validating',
      }">{{ statusText }}</span>
    </div>
    <a class="button" :href="templateUrl" download="学生建档导入模板_v1.5.xlsx">下载空白模板</a>
  </div>
  <input
    ref="picker"
    tabindex="-1"
    class="file-input"
    type="file"
    accept=".xlsx"
    aria-label="名单文件"
    @change="choose"
  />
  <div
    v-if="!batchId && !busy"
    class="dropzone reading-area"
    :class="{ dragging, busy }"
    role="button"
    tabindex="0"
    aria-label="选择或拖入学生建档模板"
    @click="openPicker"
    @keydown.enter.prevent="openPicker"
    @keydown.space.prevent="openPicker"
    @dragover.prevent="dragOver"
    @dragleave.prevent="dragLeave"
    @drop.prevent="drop"
  >
    <UiIcon name="Upload" />
    <p>{{ busy ? '正在上传…' : dragging ? '松开即上传' : '拖拽文件到此处，或点击选择' }}</p>
    <small v-if="chosenName">{{ chosenName }}</small>
  </div>
  <p v-if="busy && !batchId" role="status">正在上传 {{ chosenName }}…</p>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="batchId && loadBatch(batchId)">重试读取</button></p>
  <p v-if="notice" role="status" class="notice">{{ notice }}</p>
  <section v-if="writeFailure" class="conflict-panel" role="alert">
    <p><strong>确认未完成：</strong>{{ writeFailure.message }}</p>
    <ul>
      <li v-for="(item, index) in writeFailure.details" :key="index">
        <template v-if="item.row">原表第 {{ item.row }} 行：</template>{{ item.message }}
      </li>
    </ul>
    <p v-if="writeFailure.details.length">请按原表行号修正文件后重新上传，整批未写入</p>
  </section>
  <p v-if="loading && !batch" role="status">正在读取批次…</p>
  <section v-else-if="batch" class="batch-summary reading-area">
    <div class="page-title">
      <h2>批次 {{ batch.id.slice(0, 8) }}</h2>
    </div>
    <dl>
      <template v-if="sourceName"><dt>文件名</dt><dd>{{ sourceName }}</dd></template>
      <dt>数据行</dt>
      <dd>非空 {{ batch.row_count }} 行 · 新建 {{ batch.created_count }} 行 · 跳过 {{ batch.skipped_count }} 行 · 错误 {{ batch.error_count }} 行</dd>
    </dl>
    <details><summary>技术详情</summary><p class="hash">原文件摘要 {{ batch.source_hash }}</p></details>
    <button v-if="batch.status !== 'validating'" type="button" :disabled="busy" @click="openPicker">
      {{ batch.status === 'committed' ? '开始新批次' : '重新选择文件' }}
    </button>
    <p v-if="batch.error_message" role="alert">{{ batch.error_message }}</p>
    <div v-if="canCommit" class="page-actions">
      <button class="primary" type="button" :disabled="busy || loading" @click="commit">
        {{ busy ? '正在确认…' : '确认建档' }}
      </button>
    </div>
    <div v-else-if="batch.status === 'failed'" class="page-actions">
      <button class="primary" type="button" :disabled="busy" @click="retry">
        {{ busy ? '正在重试…' : '重试原批次' }}
      </button>
    </div>
    <p v-else-if="batch.status === 'invalid'" class="notice">请按原表行号修正文件后重新上传；内容有误的批次不能确认</p>
    <p v-else-if="batch.status === 'committed'" class="notice">
      已建档 <RouterLink class="button compact" to="/manage/students">查看学生档案</RouterLink>
    </p>
  </section>
  <p v-if="batch && rowFailure" role="alert">
    第 {{ rowFailure.page }} 页明细读取失败。{{ rowFailure.message }}
    <button type="button" @click="loadRows(rowFailure.page)">重试第 {{ rowFailure.page }} 页</button>
  </p>
  <section v-if="batch && rows.length" class="batch-rows">
    <h2>逐行预览</h2>
    <div class="scroll-table">
      <table>
        <caption>按原表行号；错误行标出字段与原因</caption>
        <thead>
          <tr>
            <th scope="col">原表行</th>
            <th scope="col">学号</th>
            <th scope="col">姓名</th>
            <th v-if="showCohort" scope="col">级部</th>
            <th scope="col">年级</th>
            <th scope="col">班级</th>
            <th v-if="showCollege" scope="col">学院</th>
            <th scope="col">处理</th>
            <th scope="col">错误</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.row_number"
            :data-row="row.row_number"
            :class="{ 'row-error': row.action === 'error' }"
          >
            <th scope="row">{{ row.row_number }}</th>
            <td>{{ display(row, 'student_no') }}</td>
            <td>{{ display(row, 'name') }}</td>
            <td v-if="showCohort">{{ display(row, 'cohort') }}</td>
            <td>{{ display(row, 'grade') }}</td>
            <td>{{ display(row, 'class_name') }}</td>
            <td v-if="showCollege">{{ display(row, 'college') }}</td>
            <td>
              <span class="state-chip" :class="{ attention: row.action === 'error', neutral: row.action === 'skip_identical' }">
                {{ actionLabels[row.action as keyof typeof actionLabels] }}
              </span>
            </td>
            <td class="row-errors">
              <template v-if="row.errors?.length">
                <p v-for="(issue, index) in row.errors" :key="(issue.field ?? 'row') + index">
                  {{ issue.field }}：{{ issue.message }}
                </p>
              </template>
              <template v-else>—</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-if="rowTotal > rowSize" :page="rowPage" :size="rowSize" :total="rowTotal" @change="loadRows" />
  </section>
</template>

<style scoped>
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.dropzone {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 42px 20px;
  margin: 4px 0 18px;
  border: 1.5px dashed var(--field-line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  text-align: center;
  cursor: pointer;
  transition: border-color 0.14s, background-color 0.14s;
}
.dropzone:hover,
.dropzone:focus-visible {
  border-color: var(--brand);
  background: var(--brand-tint);
  color: var(--brand);
}
.dropzone.dragging {
  border-color: var(--brand);
  border-style: solid;
  background: var(--brand-tint);
  color: var(--brand);
}
.dropzone.busy {
  cursor: progress;
  opacity: 0.85;
}
.dropzone .ui-icon {
  width: 28px;
  height: 28px;
}
.dropzone p {
  margin: 0;
  color: var(--ink);
  font-size: 15px;
}
.dropzone small {
  color: var(--muted);
}
@media (max-width: 700px) {
  .dropzone {
    padding: 30px 14px;
  }
}
.batch-summary {
  margin-top: 24px;
}
.batch-summary dl {
  gap: 8px 20px;
}
.hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.batch-rows {
  margin-top: 28px;
}
.row-error > * {
  background: #fff8f6;
}
.row-error > :first-child {
  box-shadow: inset 3px 0 var(--danger);
}
.row-errors {
  white-space: normal;
  min-width: 16rem;
  color: var(--danger);
  font-size: 13px;
}
.row-errors p {
  margin: 0;
}
.conflict-panel {
  margin: 16px 0;
  padding: 12px 16px;
  background: #fff4f0;
  color: var(--danger);
  border-radius: var(--radius);
}
.conflict-panel p {
  margin: 4px 0;
}
.conflict-panel ul {
  margin: 8px 0;
  padding-left: 20px;
}
</style>
