<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import { listActivityHourBatches } from '@hongyan/contracts';
import HourUpload from './HourUpload.vue';
import { beijing, statuses, useHourRead } from './display';

defineProps<{ writesPaused:boolean }>();
const emit = defineEmits<{ denied:[] }>();
const route = useRoute(), router = useRouter();
const activityId = String(route.params.id), size = 20;
const page = computed(() => {
  const value = Number(route.query.batch_page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const { data, loading, error, refresh } = useHourRead(page, async (signal) =>
  (await listActivityHourBatches({path:{id:activityId},query:{page:page.value,page_size:size},signal,throwOnError:true})).data.data, () => emit('denied'));
</script>
<template>
  <section class="hour-list reading-area">
    <h2>时长批次</h2>
    <HourUpload :activity-id="activityId" :writes-paused="writesPaused" @denied="refresh()" />
    <header><h3>批次历史</h3><button :disabled="loading" @click="refresh()">刷新历史</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading" role="status">正在读取批次…</p>
    <p v-else-if="!data?.total">本活动还没有上传批次。</p>
    <ul v-else>
      <li v-for="batch in data?.items" :key="batch.id">
        <div><RouterLink :to="{name:'hour-batch',params:{id:activityId,item:batch.id},query:route.query}">{{ batch.source_file_name ?? batch.batch_code }}</RouterLink>
          <small>{{ beijing(batch.created_at) }} · {{ batch.mode === 'new' ? '新增' : batch.mode === 'correction' ? '更正' : '撤销' }}</small></div>
        <span class="state-chip">{{ statuses[batch.status] }}</span>
      </li>
    </ul>
    <Pager v-if="data && (page > 1 || data.total > size)" :page="page" :size="size" :total="data.total"
      @change="(next) => router.push({query:{...route.query,batch_page:next}})" />
  </section>
</template>
<style scoped>
header,li { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
header { margin-top:20px; }
ul { padding:0; margin:0; list-style:none; }
li { padding:12px 0; border-top:1px solid var(--line); }
li div { min-width:0; overflow-wrap:anywhere; }
small { display:block; margin-top:4px; color:var(--muted); }
</style>
