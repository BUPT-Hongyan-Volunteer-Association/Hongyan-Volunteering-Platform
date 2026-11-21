<script setup lang="ts">
import { computed, ref } from 'vue';
import { listActivities, listManagedActivities } from '@hongyan/contracts';
import Pager from './Pager.vue';
import { usePageRead } from './usePageRead';

const props = defineProps<{ label: string; scope: 'public' | 'managed' | 'all'; disabled?: boolean; initialLabel?: string }>();
const selected = defineModel<string>({ required: true });
const query = ref(''), term = ref(''), page = ref(1);
const status = ref<'published' | 'completed' | 'cancelled'>('published');
const size = 15, labels = new Map<string, string>();
const { data, loading, error, refresh } = usePageRead(
  () => [props.scope, term.value, page.value, status.value], async (signal) => {
    const options = { signal, throwOnError: true as const };
    const filter = { q: term.value || undefined, page: page.value, page_size: size };
    const response = props.scope === 'public'
      ? await listActivities({ ...options, query: { ...filter, status: status.value } })
      : await listManagedActivities({ ...options, query: { ...filter, scope: props.scope, revision_scope: 'published' } });
    return response.data.data;
  },
);
const options = computed(() => {
  const items = (data.value?.items ?? []).filter((activity) => activity.published_revision !== undefined);
  for (const item of items) labels.set(item.id, item.title + ' · ' + item.activity_code);
  if (selected.value && !items.some((item) => item.id === selected.value)) {
    return [{ id: selected.value, text: labels.get(selected.value) ?? props.initialLabel ?? '已选活动' },
      ...items.map(({ id }) => ({ id, text: labels.get(id)! }))];
  }
  return items.map(({ id }) => ({ id, text: labels.get(id)! }));
});
function search() { page.value = 1; term.value = query.value.trim(); }
</script>
<template>
  <div class="activity-choice">
    <div class="choice-search">
      <input type="search" :aria-label="'搜索' + label" v-model="query" placeholder="输入活动名称或编号" :disabled="disabled"
        @keydown.enter.prevent="search" />
      <button type="button" :disabled="disabled" @click="search">搜索{{ label }}</button>
      <label v-if="scope === 'public'">活动状态
        <select v-model="status" :disabled="disabled" @change="page = 1">
          <option value="published">已发布</option><option value="completed">已结束</option><option value="cancelled">已取消</option>
        </select>
      </label>
    </div>
    <label>{{ label }}
      <select v-model="selected" :aria-label="label" :disabled="disabled">
        <option value="">选择{{ label }}</option>
        <option v-for="item in options" :key="item.id" :value="item.id">{{ item.text }}</option>
      </select>
    </label>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="refresh()">重读活动</button></p>
    <p v-else-if="loading" role="status">正在读取活动…</p>
    <p v-else-if="!options.length">没有匹配的获批活动。</p>
    <Pager v-if="data && data.total > size" :page="page" :size="size" :total="data.total" @change="page = $event" />
  </div>
</template>
<style scoped>
.activity-choice { display: grid; min-width: 0; gap: 8px; }
.choice-search { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.activity-choice > label { display: grid; gap: 4px; }
.activity-choice input, .activity-choice select { max-width: 100%; min-width: 0; }
.activity-choice p { margin: 0; }
</style>
