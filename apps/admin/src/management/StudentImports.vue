<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import {
  commitStudentImport,
  createCommand,
  getStudentImport,
  getStudentImportRows,
  retryStudentImportValidation,
  uploadStudentImport,
  type StudentImport,
  type StudentImportRow,
} from '@hongyan/contracts';
import templateUrl from '../../../../packages/contracts/templates/学生建档导入模板_v1.4.xlsx?url';

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
const file = ref<File>();
const chosenName = ref('');
const batch = ref<StudentImport>();
const rows = ref<StudentImportRow[]>([]);
const rowTotal = ref(0);
const rowPage = ref(1);
const rowSize = 100;
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
onUnmounted(() => {
  disposed = true;
  stopPolling();
});

const batchId = computed(() => (route.params.item ? String(route.params.item) : ''));
const statusText = computed(() => (batch.value ? statusLabels[batch.value.status] : ''));
const canCommit = computed(() => batch.value?.status === 'ready' && batch.value.error_count === 0);
const rowPages = computed(() => Math.max(1, Math.ceil(rowTotal.value / rowSize)));

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
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
  return row[field] ?? row.raw_values?.[field] ?? '—';
}
async function loadRows(page = rowPage.value) {
  const current = batch.value;
  if (!current) return;
  const result = (
    await getStudentImportRows({
      path: { id: current.id },
      query: { page, page_size: rowSize },
      throwOnError: true,
    })
  ).data.data;
  if (disposed) return;
  rowPage.value = result.page;
  rowTotal.value = result.total;
  rows.value = result.items;
}
async function loadBatch(id: string, { quiet = false } = {}) {
  if (!quiet) loading.value = true;
  error.value = '';
  try {
    const data = (await getStudentImport({ path: { id }, throwOnError: true })).data.data;
    if (disposed) return;
    batch.value = data;
    await loadRows(1);
    if (data.status === 'validating') schedulePoll();
    else stopPolling();
  } catch (reason) {
    if (!disposed) error.value = message(reason);
  } finally {
    if (!disposed) loading.value = false;
  }
}
function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(() => {
    const current = batch.value;
    if (current) void loadBatch(current.id, { quiet: true });
  }, 800);
}
function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = input.files?.[0];
  error.value = '';
  if (!next) {
    file.value = undefined;
    chosenName.value = '';
    return;
  }
  if (!/\.xlsx$/i.test(next.name) || next.size > 5_242_880) {
    error.value = '请选择不超过 5 MB 的 .xlsx 学生建档模板。';
    input.value = '';
    return;
  }
  file.value = next;
  chosenName.value = next.name;
}
async function upload() {
  const source = file.value;
  if (!source || busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await source.arrayBuffer())),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const headers = command.headers('upload_student_import', '', { file: [source.name, hash] });
    const result = await uploadStudentImport({
      body: { file: source },
      headers,
      throwOnError: true,
    });
    command.confirmed();
    if (disposed) return;
    file.value = undefined;
    chosenName.value = '';
    notice.value = '文件已受理，正在校验…';
    await router.replace({ path: '/manage/imports/' + result.data.data.id });
  } catch (reason) {
    if (!disposed) error.value = message(reason);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function commit() {
  const current = batch.value;
  if (!current || !canCommit.value || busy.value) return;
  busy.value = true;
  error.value = '';
  const body = { expected_version: current.version, source_hash: current.source_hash };
  try {
    const result = await commitStudentImport({
      path: { id: current.id },
      body,
      headers: command.headers('commit_student_import', current.id, body),
      throwOnError: true,
    });
    command.confirmed();
    if (disposed) return;
    batch.value = result.data.data;
    notice.value = '已确认建档，可在学生档案中查到新学生。';
    await loadRows(1);
  } catch (reason) {
    if (!disposed) {
      error.value = message(reason);
      void loadBatch(current.id, { quiet: true });
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function retry() {
  const current = batch.value;
  if (!current || busy.value) return;
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
    if (disposed) return;
    batch.value = result.data.data;
    notice.value = '已重新排队校验…';
    schedulePoll();
  } catch (reason) {
    if (!disposed) error.value = message(reason);
  } finally {
    if (!disposed) busy.value = false;
  }
}
watch(
  () => route.params.item,
  (value) => {
    stopPolling();
    if (value) {
      void loadBatch(String(value));
      return;
    }
    batch.value = undefined;
    rows.value = [];
    rowTotal.value = 0;
    rowPage.value = 1;
    notice.value = '';
  },
  { immediate: true },
);
</script>

<template>
  <div class="page-heading">
    <div class="page-title">
      <h1>{{ title }}</h1>
      <span v-if="batch" class="state-chip" :class="{
        attention: batch.status === 'invalid' || batch.status === 'failed',
        neutral: batch.status === 'validating',
      }">{{ statusText }}</span>
    </div>
    <a class="button" :href="templateUrl" download="学生建档导入模板_v1.4.xlsx">下载空白模板</a>
  </div>
  <form class="preview-form" @submit.prevent="upload">
    <label>名单文件
      <input type="file" accept=".xlsx" @change="choose" />
    </label>
    <p class="hint">
      使用学生建档模板 v1.4，仅接受 .xlsx、5 MB（5,242,880 字节）、5,000 条非空数据。工作表「学生建档」，六列表头（含学院）。
    </p>
    <button class="primary" type="submit" :disabled="busy || !file">
      {{ busy ? '正在上传…' : '上传并预览' }}
    </button>
    <p v-if="chosenName" class="hint">已选择：{{ chosenName }}</p>
  </form>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="batchId && loadBatch(batchId)">重试读取</button></p>
  <p v-if="notice" role="status" class="notice">{{ notice }}</p>
  <p v-if="loading && !batch" role="status">正在读取批次…</p>
  <section v-else-if="batch" class="batch-summary">
    <div class="page-title">
      <h2>批次 {{ batch.id.slice(0, 8) }}</h2>
      <span class="state-chip" :class="{ attention: batch.status === 'invalid' || batch.status === 'failed', neutral: batch.status === 'validating' }">{{ statusText }}</span>
    </div>
    <dl>
      <dt>原文件摘要</dt>
      <dd class="hash">{{ batch.source_hash }}</dd>
      <dt>数据行</dt>
      <dd>非空 {{ batch.row_count }} 行 · 新建 {{ batch.created_count }} 行 · 跳过 {{ batch.skipped_count }} 行 · 错误 {{ batch.error_count }} 行</dd>
    </dl>
    <p v-if="batch.error_message" role="alert">{{ batch.error_message }}</p>
    <div v-if="canCommit" class="page-actions">
      <button class="primary" type="button" :disabled="busy" @click="commit">
        {{ busy ? '正在确认…' : '确认建档' }}
      </button>
    </div>
    <div v-else-if="batch.status === 'failed'" class="page-actions">
      <button class="primary" type="button" :disabled="busy" @click="retry">
        {{ busy ? '正在重试…' : '重试原批次' }}
      </button>
    </div>
    <p v-else-if="batch.status === 'invalid'" class="notice">请按原表行号修正文件后重新上传；内容有误的批次不能确认。</p>
    <p v-else-if="batch.status === 'committed'" class="notice">
      已建档。可在 <RouterLink to="/manage/students">学生档案</RouterLink> 查看新学生。
    </p>
  </section>
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
            <th scope="col">级部</th>
            <th scope="col">年级</th>
            <th scope="col">班级</th>
            <th scope="col">学院</th>
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
            <td>{{ display(row, 'cohort') }}</td>
            <td>{{ display(row, 'grade') }}</td>
            <td>{{ display(row, 'class_name') }}</td>
            <td>{{ display(row, 'college') }}</td>
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
    <p v-if="rowPages > 1" class="hint">共 {{ rowTotal }} 行，第 {{ rowPage }} / {{ rowPages }} 页。</p>
  </section>
</template>

<style scoped>
.hint {
  color: var(--muted);
  font-size: 13px;
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
</style>