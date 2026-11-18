<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UiIcon from './UiIcon.vue';
import { localDate } from './activityDisplay';

const props = defineProps<{ selected: string; picker?: boolean }>();
const emit = defineEmits<{ select: [date: string] }>();
const today = localDate(Date.now());
const month = ref((props.selected || today).slice(0, 7));
watch(
  () => props.selected,
  (d) => {
    if (d) month.value = d.slice(0, 7);
  },
);
const start = computed(() => new Date(month.value + '-01T00:00:00Z'));
const offset = computed(() => (start.value.getUTCDay() + 6) % 7);
const days = computed(() =>
  new Date(Date.UTC(start.value.getUTCFullYear(), start.value.getUTCMonth() + 1, 0)).getUTCDate(),
);
const label = computed(
  () => start.value.getUTCFullYear() + ' 年 ' + (start.value.getUTCMonth() + 1) + ' 月',
);
const isoDay = (n: number) => month.value + '-' + String(n).padStart(2, '0');
function move(step: number) {
  const d = new Date(start.value);
  d.setUTCMonth(d.getUTCMonth() + step);
  month.value = d.toISOString().slice(0, 7);
}
</script>
<template>
  <aside
    class="service-calendar"
    :class="{ picker }"
    :aria-label="picker ? '选择日程日期' : '按服务日期筛选'"
  >
    <h2 v-if="!picker"><UiIcon name="Calendar" />服务日期</h2>
    <div class="month-line">
      <strong aria-live="polite">{{ label }}</strong>
      <button class="icon-button quiet" type="button" aria-label="上个月" @click="move(-1)">
        <UiIcon name="ArrowLeft" />
      </button>
      <button class="icon-button quiet" type="button" aria-label="下个月" @click="move(1)">
        <UiIcon name="ArrowRight" />
      </button>
    </div>
    <div class="days">
      <span v-for="day in '一二三四五六日'" :key="day" class="weekday">{{ day }}</span>
      <span v-for="n in offset" :key="'blank' + n" aria-hidden="true"></span>
      <button
        v-for="n in days"
        :key="isoDay(n)"
        type="button"
        :class="{ today: isoDay(n) === today }"
        :aria-current="isoDay(n) === today ? 'date' : undefined"
        :aria-pressed="selected === isoDay(n)"
        :aria-label="(picker ? '选择 ' : '筛选 ') + isoDay(n)"
        @click="emit('select', !picker && selected === isoDay(n) ? '' : isoDay(n))"
      >
        {{ n }}
      </button>
    </div>
    <div v-if="!picker" class="cal-foot">
      <button
        type="button"
        class="quiet compact"
        @click="
          month = today.slice(0, 7);
          emit('select', today);
        "
      >
        今天
      </button>
      <button type="button" class="quiet compact" :disabled="!selected" @click="emit('select', '')">
        全部日期
      </button>
    </div>
  </aside>
</template>
<style scoped>
.service-calendar {
  align-self: start;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
}
.service-calendar.picker {
  border: 0;
  padding: 0;
}
.picker .days button {
  width: 100%;
  min-height: 32px;
}
@media (max-width: 700px), (pointer: coarse) {
  .picker .days button,
  .picker .month-line button {
    min-height: 44px;
  }
}
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  margin-bottom: 14px;
}
h2 .ui-icon {
  color: var(--brand);
}
.month-line {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 6px;
}
.month-line strong {
  flex: 1;
  font-size: 14px;
}
.month-line button {
  width: 28px;
  height: 28px;
  min-height: 28px;
}
.month-line .ui-icon {
  width: 14px;
  height: 14px;
}
.days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  text-align: center;
  gap: 3px 1px;
}
.weekday {
  color: var(--muted);
  font-size: 12px;
  padding: 5px 0;
}
.days button {
  justify-self: center;
  width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.days button.today {
  background: var(--yellow-tint);
  border-color: #e6ca69;
}
.days button[aria-pressed='true'] {
  background: var(--brand);
  color: white;
}
.cal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  margin-top: 12px;
  border-top: 1px solid var(--line);
}
.cal-foot button:disabled {
  background: transparent;
  border-color: transparent;
  color: var(--muted);
}
</style>
