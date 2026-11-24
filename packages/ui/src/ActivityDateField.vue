<script setup lang="ts">
import { computed } from 'vue';
import { ElConfigProvider, ElTimePicker } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/es/components/time-picker/style/css';
import ScheduleDatePicker from './timeline/ScheduleDatePicker.vue';
import { localDate } from './activityDisplay';
const props = defineProps<{
  modelValue: string;
  label: string;
  withTime?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const day = computed(() => props.modelValue?.slice(0, 10) || '');
const clock = computed(() => props.modelValue?.slice(11, 16) || '');
function select(date: string) {
  emit('update:modelValue', props.withTime ? date + 'T' + (clock.value || '09:00') : date);
}
</script>
<template>
  <div class="activity-date">
    <ScheduleDatePicker
      :date="day || localDate(Date.now())"
      :disabled="disabled"
      :period="day || '选择日期'"
      :label="withTime ? label + '日期' : label"
      @select="select"
    />
    <ElConfigProvider v-if="withTime" :locale="zhCn">
      <ElTimePicker
        :model-value="clock"
        format="HH:mm"
        value-format="HH:mm"
        :clearable="false"
        :editable="false"
        :save-on-blur="false"
        :aria-label="label + '时分'"
        :disabled="disabled || !day"
        placeholder="时:分"
        popper-class="activity-clock"
        @update:model-value="(time: string) => time && emit('update:modelValue', day + 'T' + time)"
      />
    </ElConfigProvider>
    <button
      v-if="day && !disabled"
      type="button"
      class="quiet clear-date"
      :aria-label="'清除' + label"
      @click="emit('update:modelValue', '')"
    >
      清除
    </button>
  </div>
</template>
<style scoped>
.activity-date {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.activity-date :deep(.date-picker) {
  border: 1px solid var(--field-line);
  min-height: var(--date-field-height);
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  font-weight: 450;
  justify-content: space-between;
  min-width: 8.5em;
}
.activity-date :deep(.el-date-editor) {
  width: 7.5rem;
  --el-input-height: var(--date-field-height);
}
.activity-date :deep(input.el-input__inner) {
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
  min-height: 0;
  outline: 0;
}
.clear-date {
  font-size: 12px;
  padding-inline: 4px;
}
</style>
<style>
.activity-clock {
  --el-color-primary: var(--brand);
}
.activity-clock .el-time-spinner__item.is-active {
  color: var(--brand);
  background: var(--surface);
  font-weight: 700;
}
@media (max-width: 700px), (pointer: coarse) {
  .activity-clock .el-time-panel__footer { height: auto; padding: 0 6px; }
  .activity-clock .el-time-panel__btn { min-height: 44px; min-width: 52px; }
}
</style>
