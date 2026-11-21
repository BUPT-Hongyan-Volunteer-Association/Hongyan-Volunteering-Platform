<script setup lang="ts">
import { computed } from 'vue';
import UiIcon from './UiIcon.vue';
const props = defineProps<{ page: number; size: number; total: number }>();
defineEmits<{ change: [page: number] }>();
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)));
</script>
<template>
  <nav class="pager" aria-label="分页">
    <button
      type="button"
      class="icon-button"
      aria-label="上一页"
      title="上一页"
      :disabled="page <= 1"
      @click="$emit('change', page - 1)"
    >
      <UiIcon name="ArrowLeft" />
    </button>
    <span aria-live="polite"
      >第 <b>{{ page }}</b> / {{ pages }} 页</span
    >
    <button
      type="button"
      class="icon-button"
      aria-label="下一页"
      title="下一页"
      :disabled="page >= pages"
      @click="$emit('change', page + 1)"
    >
      <UiIcon name="ArrowRight" />
    </button>
  </nav>
</template>
<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin: 16px 0;
}
span {
  font-size: 13px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
b {
  color: var(--brand);
}
.ui-icon {
  width: 14px;
  height: 14px;
}
</style>
