<script setup lang="ts">
import { computed } from 'vue';
import type { TableRecord } from './records';
const props = defineProps<{
  records: TableRecord[];
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
  <div v-if="records.length" class="scroll-table record-table-stacked record-table">
    <table :aria-label="label">
      <thead>
        <tr>
          <th scope="col">{{ heading }}</th>
          <th v-if="statusHeading" scope="col">{{ statusHeading }}</th>
          <th v-for="label in columns" :key="label" scope="col">{{ label }}</th>
          <th v-if="$slots.actions" scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <th scope="row">{{ row.title }}</th>
          <td v-if="statusHeading" :data-label="statusHeading">{{ row.status }}</td>
          <td v-for="label in columns" :key="label" :data-label="label">
            {{ row.values[label] ?? '—' }}
          </td>
          <td v-if="$slots.actions" class="actions" data-label="操作">
            <slot name="actions" :id="row.id" />
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
.record-table td.actions {
  min-width: 5em;
}
</style>
