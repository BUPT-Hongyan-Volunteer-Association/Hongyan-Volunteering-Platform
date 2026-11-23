<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { listManagedActivities, type ActivityPage } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';

const query = ref(''), result = ref<ActivityPage>(), error = ref('');
let serial = 0, filter = '';
async function load(page: number) {
  const turn = ++serial;
  result.value = undefined;
  error.value = '';
  try {
    const { data } = await listManagedActivities({ query: { scope: 'all', q: filter, page, page_size: 20 }, throwOnError: true });
    if (turn === serial) result.value = data.data;
  } catch (e) {
    if (turn === serial) error.value = e instanceof Error ? e.message : '活动读取失败';
  }
}
function search() { filter = query.value.trim(); void load(1); }
void load(1);
onUnmounted(() => { serial++; });
</script>

<template>
  <h1>活动团队</h1>
  <form class="search" @submit.prevent="search">
    <label>活动名称或编号<input v-model="query" type="search" /></label>
    <button>查询活动</button>
  </form>
  <p v-if="error" role="alert">{{ error }} <button @click="search">重试</button></p>
  <p v-else-if="!result" role="status">正在读取活动…</p>
  <template v-else>
    <p v-if="!result.items.length">没有找到匹配的活动。</p>
    <ul class="activities">
      <li v-for="item in result.items" :key="item.id">
        <RouterLink :to="'/manage/teams/' + item.id">{{ item.title }}</RouterLink>
        <span>{{ item.activity_code }} · 主负责人 {{ item.owner_display_name }}</span>
      </li>
    </ul>
    <Pager v-if="result.total > result.page_size" :page="result.page" :size="result.page_size" :total="result.total" @change="load" />
  </template>
</template>

<style scoped>
.search, li { display:flex; align-items:end; flex-wrap:wrap; gap:12px; }
label { display:grid; gap:6px; }
.activities { max-width:50rem; padding:0; list-style:none; }
li { padding:14px 0; border-bottom:1px solid var(--line); justify-content:space-between; }
li span { color:var(--muted); }
</style>
