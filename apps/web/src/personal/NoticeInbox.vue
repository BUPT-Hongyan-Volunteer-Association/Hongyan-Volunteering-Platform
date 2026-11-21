<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import RecordSummaryList from '@hongyan/ui/RecordSummaryList.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { notices, title } from './examples';

const route = useRoute(),
  router = useRouter();
const unreadOnly = computed(() => route.query.read === 'unread');
const search = computed({
  get: () => String(route.query.search || ''),
  set: (value) =>
    router.replace({ path: '/notices', query: { ...route.query, search: value || undefined } }),
});
const rows = notices.map((n) => ({
  id: n.id,
  title: n.title,
  context: title,
  summary: n.body,
  status: n.acknowledged_at ? '已确认' : n.read_at ? '已读' : '未读',
  unread: !n.read_at,
  date: n.published_at.slice(0, 10),
  dateLabel: n.published_at.slice(5, 10),
  needsReceipt: n.requires_ack && !n.acknowledged_at,
}));
const unreadCount = rows.filter((n) => n.unread).length;
const visible = computed(() =>
  rows.filter((n) => {
    if (route.params.item) return n.id === route.params.item;
    return (
      (!unreadOnly.value || n.unread) &&
      [n.title, n.status, n.context, n.summary, n.date].some((v) => v.includes(search.value.trim()))
    );
  }),
);
const previewId = ref('');
watch(
  () => route.fullPath,
  () => {
    previewId.value = '';
  },
);
</script>

<template>
  <section class="reading-area">
    <div class="page-title">
      <h1>通知</h1>
      <span class="sample-label">示例数据</span>
    </div>
    <div class="inbox-tools">
      <nav class="section-nav" aria-label="通知筛选">
        <RouterLink
          v-for="filter in [
            { text: '全部', count: rows.length, unread: false },
            { text: '未读', count: unreadCount, unread: true },
          ]"
          active-class=""
          exact-active-class=""
          :key="filter.text"
          :class="{ current: unreadOnly === filter.unread }"
          :aria-current="unreadOnly === filter.unread ? 'true' : undefined"
          :to="{
            path: '/notices',
            query: { ...route.query, read: filter.unread ? 'unread' : undefined },
          }"
        >
          {{ filter.text }} {{ filter.count }}
        </RouterLink>
      </nav>
      <label class="search-field"
        ><UiIcon name="Search" /><span class="sr-only">搜索通知</span>
        <input v-model="search" type="search" placeholder="搜索通知" />
      </label>
    </div>
    <RouterLink
      v-if="route.params.item"
      class="back-link"
      :to="{ path: '/notices', query: route.query }"
      >返回通知</RouterLink
    >
    <RecordSummaryList v-if="visible.length" :records="visible">
      <template #action="{ row }">
        <button v-if="row.needsReceipt" class="compact quiet" @click="previewId = row.id">
          预览确认回执
        </button>
        <small v-if="previewId === row.id" role="status">当前为表单预览，正式提交待接入。</small>
      </template>
    </RecordSummaryList>
    <p v-else class="notice" role="status">
      {{ route.params.item ? '未找到该示例记录。' : '暂无匹配通知。' }}
    </p>
  </section>
</template>
<style scoped>
.inbox-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 18px 0 8px;
}
.inbox-tools .section-nav {
  margin: 0;
  border: 0;
}
.inbox-tools .search-field {
  width: min(100%, 220px);
}
</style>
