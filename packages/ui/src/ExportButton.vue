<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import {
  ApiError,
  createCommand,
  createExport,
  downloadExport,
  getExport,
  type ExportInput,
  type ExportJob,
} from '@hongyan/contracts';
import { beijing } from './hourDisplay';
import { message, noAccess } from './usePageRead';

const props = defineProps<{
  input: ExportInput;
  disabled?: boolean;
  createLabel?: string;
  downloadLabel?: string;
}>();
const emit = defineEmits<{ recheck: [] }>();
const job = ref<ExportJob>(), busy = ref(false), error = ref('');
const command = createCommand();
let active = true;
let serial = 0;
onScopeDispose(() => { active = false; });
watch(() => JSON.stringify(props.input), () => {
  serial++;
  command.confirmed();
  job.value = undefined;
  error.value = '';
  busy.value = false;
});

const labels = computed(() => {
  const fallback = {
    create: '导出筛选结果',
    download: '下载时长文件',
    failed: '生成时长文件失败。',
    name: '志愿时长.xlsx',
  };
  const byType = props.input.type === 'activity_roster'
    ? { create: '导出名单', download: '下载名单文件', failed: '生成名单文件失败。', name: '报名名单.xlsx' }
    : props.input.type === 'notice_receipts'
      ? { create: '导出回执', download: '下载回执文件', failed: '生成回执文件失败。', name: '通知回执.xlsx' }
      : props.input.type === 'admin_students'
        ? { create: '批量导出', download: '下载学生档案', failed: '生成学生档案失败。', name: '学生档案.xlsx' }
        : fallback;
  return {
    ...byType,
    ...(props.createLabel && { create: props.createLabel }),
    ...(props.downloadLabel && { download: props.downloadLabel }),
  };
});
function report(reason: unknown) {
  const missingRoute = reason instanceof ApiError && reason.status === 404 && reason.body?.message === '接口不存在';
  error.value = missingRoute ? '导出服务暂不可用。' : message(reason);
  if (noAccess(reason) && !missingRoute) {
    job.value = undefined;
    emit('recheck');
  }
}
async function start() {
  if (busy.value || props.disabled || job.value?.status === 'pending' || job.value?.status === 'running') return;
  const body = { ...props.input };
  const current = ++serial;
  busy.value = true; error.value = ''; job.value = undefined;
  try {
    const { data } = await createExport({ body, throwOnError: true, headers: command.headers('create_export', body.type, body) });
    if (active && current === serial) {
      command.confirmed();
      job.value = data.data;
    }
  } catch (reason) {
    if (active && current === serial) report(reason);
  } finally { if (active && current === serial) busy.value = false; }
}
async function readStatus() {
  if (!job.value) return;
  const id = job.value.id, current = serial;
  try {
    const { data } = await getExport({ path: { id }, throwOnError: true });
    if (active && current === serial && job.value?.id === id) { job.value = data.data; error.value = ''; }
  } catch (reason) {
    if (active && current === serial && job.value?.id === id) report(reason);
  }
}
watch(job, (current, _, cleanup) => {
  if (!current || (current.status !== 'pending' && current.status !== 'running')) return;
  const timer = window.setTimeout(() => void readStatus(), 1200);
  cleanup(() => clearTimeout(timer));
});
function filename(header: string | null) {
  const encoded = header?.match(/;\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* 继续读取普通文件名。 */ }
  }
  const plain = header?.match(/;\s*filename=(?:"([^"]+)"|([^;]+))/i);
  return (plain?.[1] ?? plain?.[2])?.trim() || labels.value.name;
}
async function download() {
  if (!job.value || job.value.status !== 'ready' || busy.value) return;
  busy.value = true; error.value = '';
  const current = serial;
  try {
    const { data, response } = await downloadExport({ path: { id: job.value.id }, parseAs: 'blob', throwOnError: true });
    if (!active || current !== serial) return;
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename(response?.headers.get('Content-Disposition') ?? null);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (reason) {
    if (!active || current !== serial) return;
    if (reason instanceof ApiError && reason.status === 409) {
      await readStatus();
      if (!active || current !== serial || job.value?.status !== 'ready') return;
    }
    report(reason);
  }
  finally { if (active && current === serial) busy.value = false; }
}
</script>
<template>
  <div class="page-actions">
    <button :disabled="disabled || busy || job?.status === 'pending' || job?.status === 'running'" @click="start">
      {{ labels.create }}
    </button>
    <span v-if="job?.status === 'pending' || job?.status === 'running'" role="status">正在生成文件…</span>
    <template v-if="job?.status === 'ready'">
      <button :disabled="busy" @click="download">{{ labels.download }}</button>
      <span v-if="job.expires_at" class="meta-line">{{ beijing(job.expires_at) }} 到期</span>
    </template>
    <span v-if="job?.status === 'expired'">文件已过期，请重新导出。</span>
    <span v-if="job?.status === 'failed'" role="alert">{{ job.error_message ?? labels.failed }}</span>
    <p v-if="error" role="alert">{{ error }}
      <button v-if="job?.status === 'pending' || job?.status === 'running'" @click="readStatus">重查生成状态</button>
    </p>
  </div>
</template>