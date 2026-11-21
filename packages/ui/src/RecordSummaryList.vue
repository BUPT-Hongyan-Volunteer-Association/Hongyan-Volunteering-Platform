<script setup lang="ts" generic="T extends SummaryRecord">
import type { SummaryRecord } from './preview';
defineProps<{ records: T[] }>();
</script>

<template>
  <ul class="summary-list">
    <li v-for="row in records" :key="row.id" :class="{ unread: row.unread }">
      <div class="summary-name">
        <div class="page-title">
          <strong
            ><slot name="title" :row="row">{{ row.title }}</slot></strong
          ><span class="state-chip" :class="{ neutral: !row.unread }">{{ row.status }}</span>
        </div>
        <small v-if="row.context">{{ row.context }}</small>
      </div>
      <div class="summary-body">
        <span>{{ row.summary }}</span
        ><slot name="action" :row="row" />
      </div>
      <time :datetime="row.date">{{ row.dateLabel || row.date }}</time>
    </li>
  </ul>
</template>
<style scoped>
.summary-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-top: 1px solid var(--line);
}
.summary-list li {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) minmax(0, 1.8fr) auto;
  align-items: center;
  gap: 8px 24px;
  border-bottom: 1px solid var(--line);
  padding: 14px 8px 14px 26px;
  position: relative;
  overflow-wrap: anywhere;
}
.summary-name {
  position: relative;
}
.unread .summary-name::before {
  content: '';
  position: absolute;
  left: -18px;
  top: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
}
.summary-name small,
time {
  color: var(--muted);
  font-size: 13px;
}
.summary-name small {
  display: block;
  margin-top: 3px;
}
.summary-body > span {
  white-space: pre-line;
}
.summary-body {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
}
time {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 899px) {
  .summary-list li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .summary-body {
    grid-row: 2;
    grid-column: 1 / -1;
  }
  time {
    grid-row: 1;
    grid-column: 2;
  }
}
</style>
