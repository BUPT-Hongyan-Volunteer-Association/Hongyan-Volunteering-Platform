<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PreviewRecord } from './preview';
import RecordTable from './RecordTable.vue';
import RecordWorkspace from './RecordWorkspace.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{
  title: string;
  records: PreviewRecord[];
  selected?: string;
  base: string;
  tableHeading?: string;
  statusHeading?: string;
  showId?: boolean;
}>();
const route = useRoute(),
  router = useRouter();
const listRoute = computed(() => ({ path: props.base, query: route.query }));
const record = computed(() => props.records.find((row) => row.id === props.selected));
function matches(row: PreviewRecord, query: string) {
  return [row.id, row.title, row.status, ...row.fields.map(([, value]) => value)].some((text) =>
    text.includes(query.trim()),
  );
}
const search = computed({
  get: () => String(route.query.search ?? ''),
  set: (value: string) =>
    router.replace({
      path:
        !props.tableHeading && record.value && matches(record.value, value)
          ? route.path
          : props.base,
      query: { ...route.query, search: value || undefined },
    }),
});
const visible = computed(() =>
  props.records.filter((row) =>
    props.tableHeading && props.selected ? row.id === props.selected : matches(row, search.value),
  ),
);
</script>

<template>
  <section class="records-page" :class="{ 'with-selection': selected && !tableHeading }">
    <div class="page-title records-title">
      <component :is="route.meta.organizer ? 'h2' : 'h1'">{{ title }}</component>
      <span class="sample-label">示例数据</span>
    </div>
    <RecordWorkspace :selected="!!selected && !tableHeading">
      <template #list>
        <RouterLink v-if="tableHeading && selected" :to="listRoute" class="back-link"
          ><UiIcon name="ArrowLeft" />返回{{ title }}</RouterLink
        >
        <div class="record-tools">
          <slot name="filters" />
          <label class="search-field">
            <UiIcon name="Search" /><span class="sr-only">筛选记录</span>
            <input v-model="search" type="search" placeholder="搜索记录" />
          </label>
        </div>
        <slot name="summary" />
        <p v-if="!visible.length" role="status" class="notice">
          {{ selected && !record ? '未找到该示例记录。' : '暂无匹配记录。' }}
        </p>
        <RecordTable
          v-else-if="tableHeading"
          :records="visible"
          :label="title"
          :heading="tableHeading"
          :status-heading="statusHeading"
        />
        <div v-else class="entry-list record-queue">
          <RouterLink
            v-for="row in visible"
            :key="row.id"
            :to="{ path: base + '/' + row.id, query: route.query }"
            :aria-current="selected === row.id ? 'true' : undefined"
          >
            <span>
              <span class="page-title"
                ><strong>{{ row.title }}</strong
                ><span class="state-chip neutral">{{ row.status }}</span></span
              >
              <small v-if="showId">编号 · {{ row.id }}</small>
              <small v-else-if="row.fields[0]">{{ row.fields[0].join(' · ') }}</small>
            </span>
            <UiIcon name="ArrowRight" />
          </RouterLink>
        </div>
        <slot v-if="!selected" name="after-list" />
      </template>
      <template #detail>
        <RouterLink class="back-link" :to="listRoute"
          ><UiIcon name="ArrowLeft" />返回{{ title }}</RouterLink
        >
        <article v-if="record" :key="record.id">
          <div class="page-title">
            <h2>{{ record.title }}</h2>
            <span class="state-chip">{{ record.status }}</span>
          </div>
          <small v-if="showId" class="record-code">编号 · {{ record.id }}</small>
          <dl class="detail-fields">
            <template v-for="[label, value] in record.fields" :key="label">
              <dt>{{ label }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
          <slot name="detail" :record="record" />
        </article>
        <p v-else role="status" class="notice">未找到该示例记录。</p>
      </template>
    </RecordWorkspace>
  </section>
</template>
<style scoped>
.records-title {
  margin-bottom: 20px;
}
.records-page:not(.with-selection) {
  max-width: var(--reading-width);
}
.record-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-bottom: 16px;
}
.record-tools .search-field {
  width: min(100%, 230px);
}
.record-tools :deep(label) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.record-queue > a {
  justify-content: space-between;
}
.record-queue small,
.record-code {
  display: block;
  margin-top: 4px;
  color: var(--muted);
}
.record-queue > a > .ui-icon {
  width: 14px;
}
.record-queue a[aria-current] {
  background: var(--brand-tint);
  box-shadow: inset 3px 0 var(--brand);
}
.records-page :deep(details) {
  margin-top: 20px;
}
.detail-fields {
  grid-template-columns: fit-content(32%) minmax(0, 1fr);
}
</style>
