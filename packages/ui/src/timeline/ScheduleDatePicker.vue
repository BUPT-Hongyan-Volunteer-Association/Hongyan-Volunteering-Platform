<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { ElPopover } from 'element-plus';
import 'element-plus/es/components/popover/style/css';
import ServiceCalendar from '../ServiceCalendar.vue';
import UiIcon from '../UiIcon.vue';
import { dropdownPosition } from '../dropdownPosition';
import { validDate } from './window';

const props = defineProps<{ date: string; period: string; highlighted?: boolean; label?: string }>();
const emit = defineEmits<{ select: [date: string] }>();
const expanded = ref(false);
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const input = ref(''),
  error = ref('');
function toggle() {
  if (!expanded.value) {
    input.value = props.date;
    error.value = '';
  }
  expanded.value = !expanded.value;
}
function focusSelection() {
  if (!expanded.value || panel.value?.contains(document.activeElement)) return;
  panel.value
    ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    ?.focus({ preventScroll: true });
}
function dismiss() {
  expanded.value = false;
  nextTick(() => trigger.value?.focus({ preventScroll: true }));
}
function outside(event: Event) {
  if (
    expanded.value &&
    event.target instanceof Node &&
    !trigger.value?.contains(event.target) &&
    !panel.value?.contains(event.target)
  ) {
    expanded.value = false;
  }
}
function escape(event: KeyboardEvent) {
  if (!expanded.value) return;
  event.stopPropagation();
  event.preventDefault();
  dismiss();
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('focusin', outside);
});
function select(date: string) {
  if (!validDate(date)) {
    error.value = '请输入有效的年、月、日，格式为 YYYY-MM-DD。';
    return;
  }
  dismiss();
  emit('select', date);
}
</script>
<template>
  <ElPopover
    :visible="expanded"
    :show-after="0"
    :hide-after="0"
    :trigger-keys="[]"
    trigger="click"
    role="dialog"
    aria-label="日期选择"
    popper-class="schedule-date-menu"
    :width="336"
    :persistent="false"
    :show-arrow="false"
    :offset="4"
    placement="bottom-start"
    :fallback-placements="['top-start']"
    teleported
    :popper-options="dropdownPosition"
    @after-enter="focusSelection"
  >
    <template #reference>
      <button
        ref="trigger"
        type="button"
        class="date-picker"
        :class="{ highlighted }"
        :aria-label="label || ('查看日期，' + period)"
        :title="label || '查看日期'"
        :aria-expanded="expanded"
        @click="toggle"
        @keydown.esc="escape"
      >
        {{ period }}<UiIcon name="Calendar" />
      </button>
    </template>
    <div ref="panel" @keydown.esc="escape">
      <ServiceCalendar picker :selected="date" @select="select" />
      <form class="date-entry" @submit.prevent="select(input.trim())">
        <input
          aria-label="输入日期"
          v-model="input"
          placeholder="YYYY-MM-DD"
          :aria-invalid="!!error"
          autocomplete="off"
        />
        <button type="submit">确定</button>
      </form>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
  </ElPopover>
</template>
<style>
.schedule-date-menu.el-popover.el-popper {
  max-width: calc(100vw - 12px);
  max-height: var(--dropdown-space, calc(100dvh - 12px));
  overflow: auto;
  padding: 8px;
  border-color: var(--line);
  border-radius: var(--radius);
  box-shadow: 0 4px 14px #17243a15;
}
@media (max-width: 338px) {
  .schedule-date-menu.el-popover.el-popper {
    padding-inline: 0;
    border-inline-width: 0;
  }
  .schedule-date-menu .days {
    column-gap: 0;
  }
}
.schedule-date-menu[data-popper-reference-hidden='true'] {
  visibility: hidden;
  pointer-events: none;
}
</style>
<style scoped>
.date-picker {
  min-width: 0;
  gap: 8px;
  border-color: transparent;
  color: var(--ink);
  font-size: 15px;
  font-weight: 600;
  padding-inline: 9px;
}
.date-picker.highlighted {
  background: var(--yellow-tint);
}
.date-picker .ui-icon {
  width: 15px;
  height: 15px;
}
.date-entry {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
  margin-top: 8px;
}
.date-entry input {
  flex: 1;
}
@media (max-width: 700px) {
  .date-picker {
    font-size: 14px;
    line-height: 1.35;
    padding-inline: 4px;
  }
  .date-picker .ui-icon {
    display: none;
  }
}
</style>
