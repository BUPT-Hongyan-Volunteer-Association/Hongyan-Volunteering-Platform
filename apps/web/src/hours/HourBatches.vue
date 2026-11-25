<script setup lang="ts">
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import RecordSummaryList from '@hongyan/ui/RecordSummaryList.vue';
import Pager from '@hongyan/ui/Pager.vue';
import { listActivityHourBatches } from '@hongyan/contracts';
import HourUpload from './HourUpload.vue';
import { beijing, statuses } from '@hongyan/ui/hourDisplay';

defineProps<{ writesPaused:boolean }>();
const emit = defineEmits<{ denied:[] }>();
const route = useRoute(), router = useRouter();
const activityId = String(route.params.id), size = 20;
const page = computed(() => pageNumber(route.query.batch_page));
const { data, loading, error, refresh } = usePageRead(page, async (signal) =>
  (await listActivityHourBatches({path:{id:activityId},query:{page:page.value,page_size:size},signal,throwOnError:true})).data.data, () => emit('denied'));
const records = computed(() => (data.value?.items ?? []).map(batch => ({
  to: { name: 'hour-batch', params: { id: activityId, item: batch.id }, query: route.query },
  id: batch.id, title: batch.source_file_name ?? batch.batch_code, status: statuses[batch.status],
  date: batch.created_at ?? '', dateLabel: beijing(batch.created_at),
  summary: batch.mode === 'new' ? '新增' : batch.mode === 'correction' ? '更正' : '撤销',
})));
</script>
<template>
  <section class="hour-list reading-area">
    <h2>时长批次</h2>
    <HourUpload :activity-id="activityId" :writes-paused="writesPaused" @denied="refresh()" />
    <header><h3>批次历史</h3><button :disabled="loading" @click="refresh()">刷新历史</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading" role="status">正在读取批次…</p>
    <p v-else-if="!data?.total">本活动还没有上传批次</p>
    <RecordSummaryList v-else :records="records" />
    <Pager v-if="data && (page > 1 || data.total > data.page_size)" :page="page" :size="data.page_size" :total="data.total"
      @change="(next) => router.push({query:{...route.query,batch_page:next}})" />
  </section>
</template>
<style scoped>
header { display:flex; align-items:center; gap:12px; margin-top:20px; }
</style>
