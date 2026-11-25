<script setup lang="ts">
import { computed } from 'vue';
import { listManagedActivities, type Profile } from '@hongyan/contracts';
import { useRoute, useRouter } from 'vue-router';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { statusLabels, serviceTime } from '@hongyan/ui/activityDisplay';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';

defineProps<{ profile: Profile }>();
const route = useRoute(), router = useRouter();
const page = computed(() => pageNumber(route.query.page));
const sourceQuery = computed(() => ({ page: page.value > 1 ? page.value : undefined }));
const { data, loading, error, refresh: load } = usePageRead(page, async signal =>
  (await listManagedActivities({ query: { scope: 'managed', page: page.value, page_size: 20 }, signal, throwOnError: true })).data.data);
</script>

<template>
  <div class="reading-area">
    <div class="page-heading">
      <h1>我的管理活动</h1>
      <div class="page-actions">
        <RouterLink class="button" to="/managed-schedule"
          ><UiIcon name="Calendar" />本人管理日程</RouterLink
        >
        <RouterLink class="button primary" to="/managed/new"
          ><UiIcon name="Plus" />新建单次活动</RouterLink
        >
      </div>
    </div>
    <p v-if="loading" class="notice" role="status">正在读取活动…</p>
    <p v-else-if="error" role="alert">{{ error }} <button @click="load()">刷新</button></p>
    <div v-else-if="!data?.items.length" class="empty-state">
      <UiIcon name="FolderOpened" />
      <p>暂无可管理的活动</p>
    </div>
    <ul v-else class="managed-list">
      <li v-for="a in data.items" :key="a.id">
        <div class="managed-info">
          <div class="meta-line">{{ a.activity_code }}</div>
          <div class="page-title">
            <strong class="row-title">{{ a.title }}</strong>
            <span class="state-chip" :class="{ attention: a.has_pending_review }">{{
              a.has_pending_review ? '待审核' : statusLabels[a.status]
            }}</span>
          </div>
          <div class="meta-line">
            <span v-if="a.location"
              ><UiIcon name="Location" />{{
                [a.campus, a.location].filter(Boolean).join(' · ')
              }}</span
            ><span><UiIcon name="Clock" />{{ serviceTime(a) }}</span>
          </div>
        </div>
        <div class="page-actions">
          <RouterLink class="button compact" :to="{ path: '/managed/' + a.id, query: sourceQuery }" :aria-label="a.title + '的活动团队'">活动团队</RouterLink>
          <RouterLink class="button" :to="{ path: '/managed/' + a.id + '/edit', query: sourceQuery }"
            ><UiIcon name="EditPen" />编辑与送审</RouterLink
          >
          <RouterLink
            class="button"
            :to="{ path: '/managed/' + a.id + '/roster', query: sourceQuery }"
            ><UiIcon name="Tickets" />报名名单</RouterLink
          >
        </div>
      </li>
    </ul>
    <Pager
      v-if="!loading && data && data.total > data.page_size"
      :page="page"
      :size="data.page_size"
      :total="data.total"
      @change="(next) => router.push({ query: { page: next } })"
    />
  </div>
</template>
<style scoped>
.managed-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-top: 1px solid var(--line);
}
.managed-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px 24px;
  padding: 18px 2px;
  border-bottom: 1px solid var(--line);
}
.managed-info {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.row-title {
  color: var(--ink);
  font-size: 18px;
  font-weight: 650;
  text-decoration: none;
  overflow-wrap: anywhere;
}
</style>
