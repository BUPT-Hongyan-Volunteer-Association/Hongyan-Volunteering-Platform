<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listActivityReviews, type ActivityReview } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { sections } from './management/sections';
const previews = ['corrections', 'incidents', 'appeals'] as const;
const rows = ref<ActivityReview[]>([]);
const total = ref(0);
const busy = ref(true);
const error = ref('');
async function load() {
  busy.value = true;
  error.value = '';
  rows.value = [];
  try {
    const response = (
      await listActivityReviews({ query: { status: 'pending', page_size: 3 }, throwOnError: true })
    ).data.data;
    rows.value = response.items;
    total.value = response.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '待审队列读取失败';
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <h1>待办</h1>
  <section class="inbox-section">
    <div class="queue-heading">
      <div class="page-title">
        <UiIcon name="DocumentChecked" />
        <h2>活动待审</h2>
      </div>
      <RouterLink class="button compact" to="/reviews"
        >查看活动审核队列<UiIcon name="ArrowRight"
      /></RouterLink>
    </div>
    <p v-if="busy" role="status">正在读取待审版本…</p>
    <p v-else-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
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
      <span class="sample-label">示例数据</span>
    </div>
    <div class="entry-list">
      <RouterLink to="/hours"
        >时长批次<span class="row-end"
          ><span class="state-chip attention">待审核</span><UiIcon name="ArrowRight" /></span
      ></RouterLink>
      <RouterLink v-for="key in previews" :key="key" :to="'/manage/' + key"
        >{{ sections[key].title }}
        <span class="row-end"
          ><span class="state-chip neutral">{{ sections[key].records[0].status }}</span
          ><UiIcon name="ArrowRight"
        /></span>
      </RouterLink>
    </div>
  </section>
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
