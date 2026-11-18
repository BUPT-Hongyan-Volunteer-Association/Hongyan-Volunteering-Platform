<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PreviewRecord } from './preview';
const props = defineProps<{ title: string; records: PreviewRecord[]; selected?: string; base: string }>();
const search = ref('');
watch(() => props.base, () => { search.value = ''; });
const visible = computed(() => props.records.filter(r => (r.title + r.status + r.fields.map(f => f[1]).join(' ')).includes(search.value.trim())));
const record = computed(() => props.records.find(r => r.id === props.selected));
</script>
<template>
  <p class="sample-label">示例数据</p>
  <template v-if="selected">
    <RouterLink :to="base">返回{{ title }}</RouterLink>
    <article v-if="record">
      <h2>{{ record.title }}</h2><p>{{ record.status }}</p>
      <dl><template v-for="[label, value] in record.fields" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template></dl>
      <slot name="detail" :record="record" />
    </article>
    <p v-else role="status">未找到该示例记录。</p>
  </template>
  <template v-else>
    <h2>{{ title }}</h2><slot name="summary" />
    <label>筛选记录 <input v-model="search" type="search" placeholder="名称或状态" /></label>
    <div v-if="visible.length" class="entry-list">
      <RouterLink v-for="r in visible" :key="r.id" :to="base + '/' + r.id">{{ r.title }} <span>{{ r.status }}</span></RouterLink>
    </div>
    <p v-else role="status">暂无匹配记录</p>
    <slot name="after-list" />
  </template>
</template>
