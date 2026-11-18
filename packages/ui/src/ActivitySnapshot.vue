<script setup lang="ts">
import type { ActivitySnapshotContent } from '@hongyan/contracts';
import { fieldLabel, fieldValue } from './activityFields';
defineProps<{ content: ActivitySnapshotContent }>();
</script>
<template>
  <dl class="snapshot-fields">
    <template v-for="(value, key) in content" :key="key">
      <template v-if="value !== undefined && value !== null && value !== ''">
        <dt>{{ fieldLabel(String(key)) }}</dt>
        <dd>{{ fieldValue(String(key), value) }}</dd>
      </template>
    </template>
  </dl>
</template>
<style scoped>
.snapshot-fields {
  font-size: 14px;
  grid-template-columns: minmax(7em, 19%) minmax(0, 1fr);
  gap: 9px 16px;
}
dd {
  white-space: pre-line;
}
</style>
