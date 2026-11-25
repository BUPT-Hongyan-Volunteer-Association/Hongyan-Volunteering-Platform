<script setup lang="ts">
import { computed } from 'vue';
import { navigation as nav } from './navigation';
import { listActivityReviews, listAppeals, listHourBatchesForReview, listHourCorrectionGroups, listIncidentsForReview } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { usePageRead } from '@hongyan/ui/usePageRead';
const tasks = [
  { ...nav.hours, label: '时长批次', read: (signal: AbortSignal) =>
    listHourBatchesForReview({ query: { status: 'pending_review', page_size: 1 }, signal, throwOnError: true }) },
  { ...nav.corrections, to: nav.corrections.to + '?group_status=pending_review', read: (signal: AbortSignal) =>
    listHourCorrectionGroups({ query: { status: 'pending_review', page_size: 1 }, signal, throwOnError: true }) },
  { ...nav.incidents, read: (signal: AbortSignal) =>
    listIncidentsForReview({ query: { status: 'pending', page_size: 1 }, signal, throwOnError: true }) },
  { ...nav.appeals, to: nav.appeals.to + '?appeal_status=pending', read: (signal: AbortSignal) =>
    listAppeals({ query: { status: 'pending', page_size: 1 }, signal, throwOnError: true }) },
];
const { data: counts, error: workError, refresh: loadWork } = usePageRead(() => true, async (signal) =>
  Promise.all(tasks.map(async (item) => (await item.read(signal)).data.data.total)),
);
const { data: reviewPage, loading: busy, error, refresh: load } = usePageRead(() => true, async signal =>
  (await listActivityReviews({ query: { status: 'pending', page_size: 3 }, signal, throwOnError: true })).data.data);
const rows = computed(() => reviewPage.value?.items ?? []);
const total = computed(() => reviewPage.value?.total ?? 0);
</script>

<template>
  <div class="reading-area">
    <h1>待办</h1>
    <section class="inbox-section">
      <div class="queue-heading">
        <div class="page-title">
          <UiIcon name="DocumentChecked" />
          <h2>活动待审</h2>
        </div>
        <RouterLink class="button compact" :to="nav.reviews.to"
          >查看活动审核队列<UiIcon name="ArrowRight"
        /></RouterLink>
      </div>
      <p v-if="busy" role="status">正在读取待审版本…</p>
      <p v-else-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
      <template v-else>
        <div class="queue-count" :class="{ empty: !total }">
          <span class="state-chip" v-if="total">待审 {{ total }} 项</span
          ><span v-else>暂无待审活动</span>
        </div>
        <div class="entry-list" v-if="rows.length">
          <RouterLink v-for="r in rows" :key="r.id" :to="'/reviews/' + r.id"
            ><strong>{{ r.snapshot.content.title }}</strong>
            <span class="row-end"
              ><span>版本 {{ r.revision }}</span
              ><UiIcon name="ArrowRight"
            /></span>
          </RouterLink>
        </div>
      </template>
    </section>
    <section class="inbox-section">
      <div class="queue-heading">
        <div class="page-title">
          <UiIcon name="Files" />
          <h2>其他审核待办</h2>
        </div>
      </div>
      <p v-if="workError" role="alert">{{ workError }} <button @click="loadWork()">重读待办</button></p>
      <div class="entry-list">
        <RouterLink v-for="(item, index) in tasks" :key="item.to" :to="item.to"
          >{{ item.label }}
          <span class="row-end"
            ><span v-if="counts" class="state-chip" :class="{ neutral: !counts[index] }">待处理 {{ counts[index] }} 项</span
            ><UiIcon name="ArrowRight"
          /></span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
<style scoped>
.inbox-section + .inbox-section {
  margin-top: 32px;
}
.queue-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
}
.queue-heading .page-title > .ui-icon {
  color: var(--brand);
}
.queue-count {
  margin-bottom: 10px;
}
.queue-count.empty {
  background: var(--surface);
  padding: 16px;
  color: var(--muted);
}
.entry-list strong {
  font-weight: 550;
}
</style>
