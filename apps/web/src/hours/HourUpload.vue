<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { createCommand, listActivityRevisions, uploadHourBatch, type HourBatch } from '@hongyan/contracts';
import templateUrl from '../../../../packages/contracts/templates/志愿时长录入模板_v1.5.xlsx?url';
import { beijing, message, noAccess, useHourRead } from './display';

const props = defineProps<{ activityId:string; writesPaused:boolean; previous?:HourBatch }>();
const emit = defineEmits<{ denied:[] }>();
const route = useRoute(), router = useRouter(), command = createCommand();
const mode = ref<'new'|'correction'>(props.previous?.mode === 'correction' ? 'correction' : 'new');
const revision = ref(props.previous?.schedule_revision ?? 0), description = ref(''), file = ref<File>();
const busy = ref(false), error = ref(''), created = ref('');
let alive = true;
onScopeDispose(() => { alive = false; });
const { data: revisions, error: revisionError, refresh } = useHourRead(() => props.activityId, async (signal) => {
  const options = [{value:0,label:'上传时的当前获批安排'}];
  for (let page = 1; ; page++) {
    const { data } = await listActivityRevisions({path:{id:props.activityId},query:{page,page_size:100},signal,throwOnError:true});
    for (const item of data.data.items) if (item.revision_state === 'approved') {
      options.push({ value:item.revision,label:'版本 '+item.revision+' · '+beijing(item.approved_at)+' 获批' });
    }
    if (page * 100 >= data.data.total) return options;
  }
}, () => emit('denied'));
const unavailable = computed(() => busy.value || !!created.value || props.writesPaused);
function select(event: Event) {
  file.value = undefined;
  error.value = '';
  const chosen = (event.target as HTMLInputElement).files?.[0];
  if (!chosen) return;
  if (!/\.xlsx$/i.test(chosen.name) || chosen.size > 5242880) { error.value = '请选择不超过 5 MB 的 .xlsx 工作簿。'; return; }
  file.value = chosen;
}
async function upload() {
  const source = file.value;
  if (!source || unavailable.value) return;
  busy.value = true;
  error.value = '';
  try {
    const body = {file:source, mode:mode.value, ...(mode.value === 'new' && revision.value && {schedule_revision:revision.value}),
      ...(props.previous && {previous_batch_id:props.previous.id}), ...(description.value.trim() && {source_description:description.value.trim()})};
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await source.arrayBuffer())), (byte) => byte.toString(16).padStart(2,'0')).join('');
    if (!alive || props.writesPaused) return;
    const { data } = await uploadHourBatch({path:{id:props.activityId},body,
      headers:command.headers('upload_hour_batch',props.activityId,{...body,file:[source.name,hash]}),throwOnError:true});
    command.confirmed();
    if (!alive) return;
    created.value = data.data.id;
    await router.push({name:'hour-batch',params:{id:props.activityId,item:data.data.id},query:route.query});
  } catch (reason) {
    if (alive) {
      error.value = message(reason);
      if (noAccess(reason)) emit('denied');
    }
  }
  finally { if (alive) busy.value = false; }
}
</script>
<template>
  <form class="hour-form" @submit.prevent="upload">
    <h3>{{ previous ? '修正后重新上传' : '上传时长表' }}</h3>
    <p>使用“时长录入”工作表，最多 5 MB、5,000 条非空记录。<a :href="templateUrl" download="志愿时长录入模板_v1.5.xlsx">下载空白模板</a></p>
    <fieldset :disabled="unavailable">
      <label>工作簿<input type="file" accept=".xlsx" @change="select" required /></label>
      <div class="hour-controls">
        <label>导入模式<UiSelect v-model="mode" label="导入模式" :disabled="unavailable" :options="[{value:'new',label:'新增时长'},{value:'correction',label:'更正时长'}]" /></label>
        <label v-if="mode === 'new'">获批安排<UiSelect v-model="revision" label="获批安排" :disabled="unavailable || !revisions" :options="revisions ?? []" /></label>
        <span v-else>更正绑定原记录的获批安排。</span>
      </div>
      <p v-if="mode === 'new' && revisionError" role="alert">{{ revisionError }} <button type="button" @click="refresh()">重读安排</button></p>
      <label>批次说明（选填）<input v-model="description" maxlength="2000" /></label>
      <button class="primary" :disabled="unavailable || !file || (mode === 'new' && !revisions)">{{ busy ? '正在上传…' : '上传并预览' }}</button>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <RouterLink v-if="created" :to="{name:'hour-batch',params:{id:activityId,item:created},query:route.query}">已创建，查看批次</RouterLink>
  </form>
</template>
<style scoped>
.hour-form { padding: 16px; background: #f5f8fc; border: 1px solid var(--line); border-radius: 6px; }
h3 { margin: 0; }
p { color: var(--muted); }
fieldset { display: grid; justify-items: start; gap: 14px; padding: 0; border: 0; min-width: 0; }
label { display: grid; gap: 5px; max-width: 100%; }
input { max-width: 100%; box-sizing: border-box; }
.hour-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
</style>
