<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PreviewRecord } from './preview';
import UiIcon from './UiIcon.vue';
const props = defineProps<{
  title: string;
  records: PreviewRecord[];
  selected?: string;
  base: string;
}>();
const route = useRoute(),
  router = useRouter();
const search = computed({
  get: () => String(route.query.search ?? ''),
  set: (s: string) => {
    void router.replace({ query: { ...route.query, search: s || undefined } });
  },
});
const visible = computed(() =>
  props.records.filter((r) =>
    (r.title + r.status + r.fields.map((f) => f[1]).join(' ')).includes(search.value.trim()),
  ),
);
const record = computed(() => props.records.find((r) => r.id === props.selected));
</script>
<template>
  <section class="records-page">
    <template v-if="selected">
      <RouterLink class="back-link" :to="{ path: base, query: $route.query }"
        ><UiIcon name="ArrowLeft" />返回{{ title }}</RouterLink
      >
      <article v-if="record">
        <div class="page-title">
          <h2>{{ record.title }}</h2>
          <span class="state-chip">{{ record.status }}</span>
        </div>
        <p class="sample-label detail-sample">示例数据</p>
        <dl class="detail-fields">
          <template v-for="[label, value] in record.fields" :key="label"
            ><dt>{{ label }}</dt>
            <dd>{{ value }}</dd></template
          >
        </dl>
        <slot name="detail" :record="record" />
      </article>
      <p v-else role="status" class="notice">未找到该示例记录。</p>
    </template>
    <template v-else>
      <div class="page-heading">
        <div class="page-title">
          <component :is="$route.meta.organizer ? 'h2' : 'h1'">{{ title }}</component
          ><span class="sample-label">示例数据</span>
        </div>
        <div class="record-tools">
          <slot name="filters" /><label class="search-field"
            ><UiIcon name="Search" /><span class="sr-only">筛选记录</span
            ><input v-model="search" type="search" placeholder="按名称、状态查找"
          /></label>
        </div>
      </div>
      <slot name="summary" />
      <div v-if="visible.length" class="entry-list">
        <RouterLink
          v-for="r in visible"
          :key="r.id"
          :to="{ path: base + '/' + r.id, query: $route.query }"
        >
          <span class="record-name"
            ><strong>{{ r.title }}</strong
            ><small v-if="r.fields[0]">{{ r.fields[0][0] }} · {{ r.fields[0][1] }}</small></span
          ><span class="row-end"
            ><span class="state-chip neutral">{{ r.status }}</span
            ><UiIcon name="ArrowRight"
          /></span>
        </RouterLink>
      </div>
      <div v-else class="empty-state" role="status">
        <UiIcon name="Search" />
        <p>暂无匹配记录</p>
      </div>
      <slot name="after-list" />
    </template>
  </section>
</template>
<style scoped>
.records-page :deep(details) {
  margin-top: 22px;
}
.records-page :deep(summary) {
  display: list-item;
  padding-block: 8px;
}
.detail-sample {
  margin-top: 8px;
}
.entry-list strong {
  font-size: 15px;
  font-weight: 550;
}
.detail-fields {
  grid-template-columns: minmax(6em, max-content) minmax(0, 1fr);
  max-width: 62rem;
  gap: 12px 24px;
}
.search-field {
  width: min(100%, 244px);
}
.record-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  max-width: 100%;
}
.record-name {
  min-width: 0;
}
.record-name small {
  display: block;
  color: var(--muted);
  font-size: 13px;
  margin-top: 2px;
}
@media (max-width: 700px) {
  .record-tools {
    width: 100%;
  }
}
@media (max-width: 700px) {
  .search-field {
    width: 100%;
  }
  .detail-fields {
    grid-template-columns: minmax(72px, 27%) minmax(0, 1fr);
    gap: 10px 12px;
  }
  .row-end {
    font-size: 12px;
  }
}
</style>
