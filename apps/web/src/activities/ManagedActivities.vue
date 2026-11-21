<script setup lang="ts">
import { computed, watch, ref } from 'vue';
import { hasStudentAccess } from '../identity';
import { listManagedActivities, type Profile, type Activity } from '@hongyan/contracts';

import { useRoute, useRouter } from 'vue-router';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { statusLabels, serviceTime } from '@hongyan/ui/activityDisplay';
import Pager from '@hongyan/ui/Pager.vue';
const props = defineProps<{ profile: Profile }>();
const route = useRoute(),
  router = useRouter();
const page = computed(() => {
  const value = Number(route.query.page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const total = ref(0),
  size = ref(20);
const sourceQuery = computed(() => ({ page: page.value > 1 ? page.value : undefined }));
let serial = 0;
const activities = ref<Activity[]>([]),
  error = ref(''),
  loading = ref(true);
async function load() {
  const turn = ++serial;
  loading.value = true;
  error.value = '';
  activities.value = [];
  try {
    const data = (
      await listManagedActivities({
        query: { scope: 'managed', page: page.value, page_size: 20 },
        throwOnError: true,
      })
    ).data.data;
    if (turn !== serial) return;
    activities.value = data.items;
    total.value = data.total;
    size.value = data.page_size;
  } catch (e) {
    if (turn !== serial) return;
    error.value = e instanceof Error ? e.message : '读取失败';
  } finally {
    if (turn === serial) loading.value = false;
  }
}
watch(page, load, { immediate: true });
</script>

<template>
  <div class="reading-area">
    <RouterLink class="back-link" :to="hasStudentAccess(props.profile) ? '/mine' : '/'">
      <UiIcon name="ArrowLeft" />{{ hasStudentAccess(props.profile) ? '返回我的' : '返回活动列表' }}
    </RouterLink>
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
    <p v-else-if="error" role="alert">{{ error }} <button @click="load">刷新</button></p>
    <div v-else-if="!activities.length" class="empty-state">
      <UiIcon name="FolderOpened" />
      <p>暂无可管理的活动</p>
    </div>
    <ul v-else class="managed-list">
      <li v-for="a in activities" :key="a.id">
        <div class="managed-info">
          <div class="meta-line">{{ a.activity_code }}</div>
          <div class="page-title">
            <RouterLink class="row-title" :to="{ path: '/managed/' + a.id, query: sourceQuery }">{{
              a.title
            }}</RouterLink>
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
      v-if="!loading && !error && total > size"
      :page="page"
      :size="size"
      :total="total"
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
.row-title:hover {
  color: var(--brand);
  text-decoration: underline;
}
</style>
