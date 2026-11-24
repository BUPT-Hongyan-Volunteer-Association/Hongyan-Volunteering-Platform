<script setup lang="ts" generic="T extends string | number">
import { computed, shallowRef } from 'vue';
import { ElSelect } from 'element-plus';
import { dropdownPosition } from './dropdownPosition';
import 'element-plus/es/components/select/style/css';

type Choice = T | { value: T; label: string; disabled?: boolean };
const props = defineProps<{
  label: string;
  options: readonly Choice[];
  modelValue?: T;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T]; open: [] }>();
const local = shallowRef<T>();
const choices = computed(() =>
  props.options.map((choice) =>
    typeof choice === 'object' ? choice : { value: choice, label: String(choice) },
  ),
);
const selected = computed(
  () =>
    props.modelValue ??
    choices.value.find((o) => o.value === local.value)?.value ??
    choices.value[0]?.value,
);
function select(value: T) {
  local.value = value;
  emit('update:modelValue', value);
}
</script>
<template>
  <ElSelect
    class="platform-select"
    :aria-label="label"
    :disabled="disabled"
    :model-value="selected"
    @update:model-value="select"
    @visible-change="(visible: boolean) => visible && emit('open')"
    :options="choices"
    :empty-values="[null, undefined]"
    placement="bottom-start"
    :fallback-placements="['top-start']"
    teleported
    :show-arrow="false"
    :offset="4"
    :popper-options="dropdownPosition"
    popper-class="platform-options"
  />
</template>
<style>
.platform-select.el-select {
  --el-border-color: var(--field-line);
  --el-border-color-hover: #829ac1;
  --el-text-color-regular: var(--ink);
  --el-border-radius-base: var(--radius);
  width: var(--select-width, 8.25rem);
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
}
.platform-select .el-select__wrapper {
  min-height: var(--select-height, 36px);
}
.platform-select .el-select__wrapper.is-focused {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.platform-options.el-popper {
  max-width: calc(100vw - 12px);
  border-radius: var(--radius);
  box-shadow: 0 4px 14px #17243a15;
}
.platform-options[data-popper-reference-hidden='true'] {
  visibility: hidden;
  pointer-events: none;
}
.platform-options .el-select-dropdown__wrap {
  max-height: min(274px, calc(var(--dropdown-space, 50dvh) - 2px));
}
.platform-options .el-select-dropdown__item {
  color: var(--ink);
}
.platform-options .el-select-dropdown__item.is-selected {
  color: var(--brand);
  background: var(--brand-tint);
}
.platform-options .el-select-dropdown__item.is-hovering {
  background: var(--surface);
}
.preview-form,
.field-grid {
  --select-width: 100%;
}
@media (max-width: 700px), (pointer: coarse) {
  .platform-select .el-select__wrapper {
    min-height: 44px;
  }
  .platform-options .el-select-dropdown__item {
    height: 44px;
    line-height: 44px;
  }
}
</style>
