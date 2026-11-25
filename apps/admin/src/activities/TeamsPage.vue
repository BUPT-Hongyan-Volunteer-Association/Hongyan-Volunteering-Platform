<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listManagedActivities } from '@hongyan/contracts';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import Pager from '@hongyan/ui/Pager.vue';

const query = ref('');
const route = useRoute(), router = useRouter();
const pendingOnly = computed(() => route.query.owner_unavailable === 'true');
const { data: result, error, refresh: load } = usePageRead(() => route.fullPath, async signal => {
  const filter = typeof route.query.q === 'string' ? route.query.q : '';
  query.value = filter;
  const { data } = await listManagedActivities({ query: {
    scope: 'all', q: filter, owner_unavailable: pendingOnly.value || undefined,
    page: pageNumber(route.query.page), page_size: 20,
  }, signal, throwOnError: true });
  return data.data;
});
watch(result, rows => {
  if (!rows) return;
  const last = Math.max(1, Math.ceil(rows.total / rows.page_size));
  if (rows.page > last) changePage(last);
});
function search(pending = pendingOnly.value) {
  const target = { path: route.path, query: { q: query.value.trim() || undefined, owner_unavailable: pending ? 'true' : undefined } };
  if (router.resolve(target).fullPath === route.fullPath) void load();
  else void router.replace(target);
}
function changePage(page: number) {
  void router.replace({ query: { ...route.query, page: page > 1 ? String(page) : undefined } });
}
</script>

<template>
  <h1>活动团队</h1>
  <form class="search" @submit.prevent="search()">
    <label>活动名称或编号<input v-model="query" type="search" /></label>
    <button>查询活动</button>
    <label class="pending"><input type="checkbox" :checked="pendingOnly" @change="search(!pendingOnly)" />仅看待接管活动</label>
  </form>
  <p v-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
  <p v-else-if="!result" role="status">正在读取活动…</p>
  <template v-else>
    <p v-if="!result.total">{{ pendingOnly ? '当前筛选范围内没有待接管活动' : '没有找到匹配的活动' }}</p>
    <ul class="activities entry-list">
      <li v-for="item in result.items" :key="item.id">
        <RouterLink :to="{ path: '/manage/teams/' + item.id, query: route.query }" :aria-label="item.title">
          <strong>{{ item.title }}</strong>
          <span class="owner">{{ item.activity_code }} · 主负责人 {{ item.owner_display_name }}</span>
          <span v-if="item.owner_unavailable" class="state-chip attention">待接管</span>
          <span class="row-end"><UiIcon name="ArrowRight" /></span>
        </RouterLink>
      </li>
    </ul>
    <Pager v-if="result.total > result.page_size" :page="result.page" :size="result.page_size" :total="result.total" @change="changePage" />
  </template>
</template>

<style scoped>
.search { display:flex; align-items:end; flex-wrap:wrap; gap:12px; }
label { display:grid; gap:6px; }
.pending { display:flex; align-items:center; min-height:44px; }
.activities { max-width:50rem; padding:0; list-style:none; }
.activities > li > a { display:grid; grid-template-columns:minmax(0,1fr) auto auto; }
.activities .owner { grid-column:1; }
.activities .row-end { grid-column:3; grid-row:1 / span 2; }
.activities .state-chip { grid-column:2; grid-row:1 / span 2; }
@media(min-width:701px) {
  .activities > li > a { grid-template-columns:minmax(10em,1fr) auto auto auto; }
  .activities .owner { grid-column:2; }
  .activities .state-chip { grid-column:3; grid-row:1; }
  .activities .row-end { grid-column:4; grid-row:1; }
}
.owner { color:var(--muted); }
</style>
