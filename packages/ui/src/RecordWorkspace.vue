<script setup lang="ts">
defineProps<{ selected: boolean }>();
</script>
<template>
  <div class="record-workspace" :class="{ 'has-detail': selected }">
    <div class="record-list-pane"><slot name="list" /></div>
    <div v-if="selected" class="record-detail-pane"><slot name="detail" /></div>
  </div>
</template>
<style scoped>
.record-list-pane,
.record-detail-pane {
  min-width: 0;
}
@media (max-width: 1023px) {
  .has-detail > .record-list-pane {
    display: none;
  }
}
@media (min-width: 1024px) {
  .record-workspace.has-detail {
    display: grid;
    grid-template-columns: minmax(14rem, min(30%, 22rem)) minmax(0, 1fr);
    align-items: start;
  }
  .has-detail > .record-list-pane {
    padding-right: clamp(16px, 2vw, 32px);
  }
  .has-detail > .record-detail-pane {
    padding-left: clamp(18px, 2.5vw, 40px);
    border-left: 1px solid var(--line);
  }
}
</style>
