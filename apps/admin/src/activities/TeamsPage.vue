<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listManagedActivities, type ActivityPage } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';

const query = ref(''), result = ref<ActivityPage>(), error = ref('');
const route = useRoute(), router = useRouter();
const pendingOnly = computed(() => route.query.owner_unavailable === 'true');
let serial = 0;
async function load() {
  const turn = ++serial;
  const page = Number(route.query.page);
  const filter = typeof route.query.q === 'string' ? route.query.q : '';
  query.value = filter;
  result.value = undefined;
  error.value = '';
  try {
    const { data } = await listManagedActivities({ query: {
      scope: 'all', q: filter, owner_unavailable: pendingOnly.value || undefined,
      page: Number.isSafeInteger(page) && page > 0 ? page : 1, page_size: 20,
    }, throwOnError: true });
    if (turn === serial) result.value = data.data;
  } catch (e) {
    if (turn === serial) error.value = e instanceof Error ? e.message : '活动读取失败';
  }
}
function search(pending = pendingOnly.value) {
  const target = { path: route.path, query: { q: query.value.trim() || undefined, owner_unavailable: pending ? 'true' : undefined } };
  if (router.resolve(target).fullPath === route.fullPath) void load();
  else void router.replace(target);
}
function changePage(page: number) {
  void router.replace({ query: { ...route.query, page: page > 1 ? String(page) : undefined } });
}
watch(() => route.fullPath, load, { immediate: true });
onUnmounted(() => { serial++; });
</script>

<template>
  <h1>活动团队</h1>
  <form class="search" @submit.prevent="search()">
    <label>活动名称或编号<input v-model="query" type="search" /></label>
    <button>查询活动</button>
    <label class="pending"><input type="checkbox" :checked="pendingOnly" @change="search(!pendingOnly)" />仅看待接管活动</label>
  </form>
  <p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
  <p v-else-if="!result" role="status">正在读取活动…</p>
  <template v-else>
    <p v-if="!result.items.length">{{ pendingOnly ? '当前筛选范围内没有待接管活动。' : '没有找到匹配的活动。' }}</p>
    <ul class="activities">
      <li v-for="item in result.items" :key="item.id">
        <RouterLink :to="{ path: '/manage/teams/' + item.id, query: route.query }">{{ item.title }}</RouterLink>
        <span class="owner">{{ item.activity_code }} · 主负责人 {{ item.owner_display_name }}</span>
        <span v-if="item.owner_unavailable" class="state-chip attention">待接管</span>
      </li>
    </ul>
    <Pager v-if="result.total > result.page_size" :page="result.page" :size="result.page_size" :total="result.total" @change="changePage" />
  </template>
</template>

<style scoped>
.search, li { display:flex; align-items:end; flex-wrap:wrap; gap:12px; }
label { display:grid; gap:6px; }
.pending { display:flex; align-items:center; min-height:44px; }
.activities { max-width:50rem; padding:0; list-style:none; }
li { padding:14px 0; border-bottom:1px solid var(--line); justify-content:space-between; }
.owner { color:var(--muted); }
</style>
