<script setup lang="ts">
import { computed, watch, ref } from 'vue';
import { listManagedActivities, type Activity } from '@hongyan/contracts';

import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
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
  <RouterLink to="/mine">返回我的</RouterLink>
  <h1>我的管理活动</h1>
  <RouterLink to="/managed-schedule">本人管理日程</RouterLink> ·
  <RouterLink to="/managed/new">新建单次活动</RouterLink>
  <p v-if="loading">正在读取活动…</p>
  <p v-else-if="error" role="alert">{{ error }} <button @click="load">刷新</button></p>
  <p v-else-if="!activities.length">暂无可管理的活动</p>
  <ul>
    <li v-for="a in activities" :key="a.id">
      <RouterLink :to="{ path: '/managed/' + a.id, query: sourceQuery }">{{ a.title }}</RouterLink>
      <RouterLink :to="{ path: '/managed/' + a.id + '/edit', query: sourceQuery }"
        >编辑与送审</RouterLink
      >
      ·
      <RouterLink :to="{ path: '/managed/' + a.id + '/roster', query: sourceQuery }"
        >报名名单</RouterLink
      >
    </li>
  </ul>
  <Pager
    v-if="!loading && !error && total > size"
    :page="page"
    :size="size"
    :total="total"
    @change="(next) => router.push({ query: { page: next } })"
  />
</template>
