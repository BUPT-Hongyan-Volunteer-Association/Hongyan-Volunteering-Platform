<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  listManagedActivities,
  type Activity,
} from '@hongyan/contracts';

const activities = ref<Activity[]>([]),
  error = ref(''),
  loading = ref(true);
async function load() {
  loading.value = true;
  error.value = '';
  activities.value = [];
  try {
    activities.value = (
      await listManagedActivities({ query: { scope: 'managed' }, throwOnError: true })
    ).data.data.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <RouterLink to="/mine">返回我的</RouterLink>
  <h1>我的管理活动</h1>
  <RouterLink to="/managed/new">新建单次活动</RouterLink>
  <p v-if="loading">正在读取活动…</p>
  <p v-else-if="error" role="alert">{{ error }} <button @click="load">刷新</button></p>
  <p v-else-if="!activities.length">暂无可管理的活动</p>
  <ul>
    <li v-for="a in activities" :key="a.id">
      <RouterLink :to="'/managed/' + a.id">{{ a.title }}</RouterLink>
      <RouterLink :to="'/managed/' + a.id + '/edit'">编辑与送审</RouterLink> ·
      <RouterLink :to="'/managed/' + a.id + '/roster'">报名名单</RouterLink>
    </li>
  </ul>
</template>
