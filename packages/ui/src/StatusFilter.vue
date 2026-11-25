<script setup lang="ts">
import SegmentedControl from './SegmentedControl.vue';

defineProps<{
  label: string;
  modelValue: string;
  options: Record<string, string>;
}>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="status-filter">
    <span>{{ label }}</span>
    <SegmentedControl class="status-options" :aria-label="label">
      <button v-for="(text, value) in options" :key="value" type="button"
        :aria-pressed="value === modelValue" @click="$emit('update:modelValue', value)">
        {{ text }}
      </button>
    </SegmentedControl>
  </div>
</template>

<style scoped>
.status-filter {
  display: grid;
  justify-items: start;
  min-width: 0;
  gap: var(--space-4);
  color: var(--muted);
  font-size: var(--text-control);
}
.status-options {
  max-width: 100%;
  flex-wrap: wrap;
  gap: 1px;
  background: var(--field-line);
}
.status-options button {
  flex: 1 0 auto;
  border: 0;
}
</style>
