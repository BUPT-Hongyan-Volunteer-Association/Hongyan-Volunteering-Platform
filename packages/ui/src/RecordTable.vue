<script setup lang="ts">
import { computed } from 'vue';
import type { PreviewRecord } from './preview';
const props = defineProps<{
  records: PreviewRecord[];
  label: string;
  heading: string;
  statusHeading?: string;
}>();
const columns = computed(() => [
  ...new Set(props.records.flatMap((row) => row.fields.map(([label]) => label))),
]);
const rows = computed(() =>
  props.records.map((row) => ({ ...row, values: Object.fromEntries(row.fields) })),
);
</script>
<template>
  <div v-if="records.length" class="scroll-table record-table">
    <table :aria-label="label">
      <thead>
        <tr>
          <th scope="col">{{ heading }}</th>
          <th v-if="statusHeading" scope="col">{{ statusHeading }}</th>
          <th v-for="label in columns" :key="label" scope="col">{{ label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <th scope="row">{{ row.title }}</th>
          <td v-if="statusHeading" :data-label="statusHeading">{{ row.status }}</td>
          <td v-for="label in columns" :key="label" :data-label="label">
            {{ row.values[label] ?? '—' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.record-table th,
.record-table td {
  white-space: normal;
  overflow-wrap: anywhere;
}
.record-table th:first-child {
  min-width: 6em;
}
.record-table td {
  min-width: 6em;
}
.record-table td:last-child {
  min-width: 12em;
}
@media (max-width: 700px) {
  .record-table {
    border: 0;
    border-radius: 0;
  }
  .record-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .record-table tbody,
  .record-table tr,
  .record-table th,
  .record-table td {
    display: block;
  }
  .record-table tbody tr {
    border-block-start: 1px solid var(--line);
    padding: 8px 0 12px;
  }
  .record-table tbody tr > * {
    position: static;
    border: 0;
    padding: 4px 0;
  }
  .record-table tbody td {
    display: grid;
    grid-template-columns: 6em minmax(0, 1fr);
    gap: 0 12px;
  }
  .record-table td::before {
    content: attr(data-label);
    color: var(--muted);
  }
}
</style>
