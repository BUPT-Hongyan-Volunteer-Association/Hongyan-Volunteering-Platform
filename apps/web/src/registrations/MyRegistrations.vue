<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listMyRegistrations, type Registration } from '@hongyan/contracts';
import RecordSummaryList from '@hongyan/ui/RecordSummaryList.vue';
import RequestQueue from './RequestQueue.vue';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { registrationLabels } from './labels';

const route = useRoute();
const router = useRouter();
const page = computed(() => pageNumber(route.query.page));
const status = computed(() => String(route.query.status || '') as Registration['status'] | '');
const item = computed(() => String(route.params.item || ''));
const options = [
  { value: '', label: '全部状态' },
  ...Object.entries(registrationLabels).map(([value, label]) => ({ value, label })),
];
const { data: result, error, loading: refreshing, refresh } = usePageRead(
  () => route.fullPath,
  async signal => {
    const { data } = await listMyRegistrations({
      query: item.value ? { id: item.value } : { page: page.value, page_size: 10, status: status.value || undefined },
      signal, throwOnError: true,
    });
    return data.data;
  },
);
const load = () => refresh(false);
const rows = computed(() =>
  (result.value?.items || []).map((row) => ({
    id: row.id,
    activityId: row.activity_id,
    title: row.activity_title || '活动报名',
    status: registrationLabels[row.status],
    date: row.submitted_at,
    dateLabel: localDateTime(row.submitted_at),
    summary: [
      row.pending_exit_request_id && '退出申请待处理',
      row.pending_restoration_request_id && '恢复申请待处理',
      row.statement && '申请说明 · ' + row.statement,
      row.decision_reason && '处理说明 · ' + row.decision_reason,
    ]
      .filter(Boolean)
      .join('　'),
  })),
);
const feedback = ref('');
function filter(value: string) {
  void router.push({ path: '/registrations', query: { status: value || undefined } });
}
watch(() => route.fullPath, () => { feedback.value = ''; });
onMounted(() => window.addEventListener('focus', load));
onUnmounted(() => {
  window.removeEventListener('focus', load);
});
</script>

<template>
  <section class="reading-area">
    <RouterLink v-if="item" class="back-link" :to="{ path: '/registrations', query: route.query }">
      <UiIcon name="ArrowLeft" />返回我的报名
    </RouterLink>
    <header class="page-heading">
      <h1>{{ item ? '报名详情' : '我的报名' }}</h1>
      <UiSelect
        v-if="!item"
        label="报名状态"
        :model-value="status"
        :options="options"
        @update:model-value="filter"
      />
    </header>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <p v-if="error" role="alert">{{ error }} <button @click="load">重新读取</button></p>
    <p v-else-if="!result" role="status">正在读取报名记录…</p>
    <template v-else>
      <RecordSummaryList v-if="rows.length" :records="rows">
        <template #action="{ row }">
          <RouterLink v-if="!item" :to="{ path: '/registrations/' + row.id, query: route.query }">办理与进度</RouterLink>
          <RouterLink
            :to="{
              path: '/activities/' + row.activityId,
              state: { registrationReturn: route.fullPath },
            }"
            >查看活动详情</RouterLink
          >
        </template>
      </RecordSummaryList>
      <p v-else>{{ item ? '未找到该报名记录。' : '暂无符合条件的报名记录。' }}</p>
      <RequestQueue v-if="item && result.items[0]" :registration="result.items[0]" :writes-paused="refreshing" :activity-id="result.items[0].activity_id"
        @changed="msg => { feedback = msg; load(); }" />
      <Pager
        v-if="!item"
        :page="page"
        :size="result.page_size"
        :total="result.total"
        @change="(n) => router.push({ query: { ...route.query, page: n } })"
      />
    </template>
  </section>
</template>
