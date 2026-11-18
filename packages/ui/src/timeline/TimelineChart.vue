<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TimelineActivity, TimelineItem } from '@hongyan/contracts';
import { localTime, palette } from './examples';
const props = defineProps<{
  rows: TimelineActivity[];
  start: number;
  end: number;
  hour: boolean;
  now: number;
  selected?: string;
}>();
const emit = defineEmits<{ choose: [row: TimelineActivity, segment: TimelineItem] }>();
const width = computed(() => (props.hour ? 1152 : 1008));
const ticks = computed(() =>
  Array.from({ length: props.hour ? 24 : 7 }, (_, i) => ({
    x: (i * width.value) / (props.hour ? 24 : 7),
    label: props.hour
      ? i.toString().padStart(2, '0') + ':00'
      : new Date(props.start + i * 86400000).toLocaleDateString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          weekday: 'short',
          month: 'numeric',
          day: 'numeric',
        }),
  })),
);
const choices = ref<{ row: TimelineActivity; segments: TimelineItem[] }>();
watch(
  () => [props.start, props.rows],
  () => {
    choices.value = undefined;
  },
);
function x(time: number) {
  return Math.min(
    width.value,
    Math.max(0, ((time - props.start) * width.value) / (props.end - props.start)),
  );
}
function choose(row: TimelineActivity, seg: TimelineItem) {
  choices.value = undefined;
  emit('choose', row, seg);
}
function hit(event: MouseEvent, row: TimelineActivity) {
  const px = event.clientX - (event.currentTarget as SVGSVGElement).getBoundingClientRect().left;
  const segments = row.segments.filter((s) => {
    const left = x(Date.parse(s.starts_at)),
      right = x(Date.parse(s.ends_at)),
      center = (left + right) / 2;
    return Math.abs(px - center) <= Math.max(22, (right - left) / 2);
  });
  if (segments.length === 1) choose(row, segments[0]);
  else if (segments.length > 1) choices.value = { row, segments };
}
</script>
<template>
  <div class="chart-scroll" tabindex="0" aria-label="可横向滚动的活动时间轴">
    <table class="chart">
      <thead>
        <tr>
          <th>活动名称</th>
          <td>
            <svg :width="width" height="36" aria-hidden="true">
              <text v-for="t in ticks" :key="t.x" :x="t.x + 4" y="24">{{ t.label }}</text>
            </svg>
          </td>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.activity_id">
          <th scope="row">
            <button @click="choose(row, row.segments[0])">
              <i :style="{ background: palette[row.color_index] }" />{{ row.title }}
            </button>
          </th>
          <td>
            <svg
              :width="width"
              height="52"
              :aria-label="row.title + '的时段'"
              @click="hit($event, row)"
            >
              <line
                v-for="t in ticks"
                :key="t.x"
                :x1="t.x"
                :x2="t.x"
                y1="0"
                y2="52"
                stroke="#e4e9f0"
              />
              <rect
                v-for="s in row.segments"
                :key="s.occurrence_key"
                tabindex="0"
                role="button"
                :aria-label="
                  row.title + ' ' + localTime(s.starts_at) + ' 至 ' + localTime(s.ends_at)
                "
                :x="x(Date.parse(s.starts_at))"
                :width="x(Date.parse(s.ends_at)) - x(Date.parse(s.starts_at))"
                y="14"
                height="24"
                rx="3"
                :fill="palette[row.color_index]"
                :stroke="s.occurrence_key === selected ? '#F1C64B' : 'none'"
                stroke-width="3"
                @keydown.enter.prevent="choose(row, s)"
                @keydown.space.prevent="choose(row, s)"
              />
              <line
                v-if="start <= now && now < end"
                class="now-line"
                :x1="x(now)"
                :x2="x(now)"
                y1="0"
                y2="52"
                stroke="#003399"
                stroke-dasharray="4 3"
                pointer-events="none"
              />
            </svg>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <section v-if="choices">
    <h3>选择时段</h3>
    <button v-for="s in choices.segments" :key="s.occurrence_key" @click="choose(choices.row, s)">
      {{ localTime(s.starts_at) }} 至 {{ localTime(s.ends_at) }}
    </button>
  </section>
</template>
<style scoped>
.chart-scroll {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.chart {
  border-spacing: 0;
  width: max-content;
  font-size: 14px;
}
.chart th,
.chart td {
  border-bottom: 1px solid var(--line);
  padding: 0;
}
.chart th {
  position: sticky;
  left: 0;
  z-index: 1;
  background: white;
  min-width: 108px;
  max-width: 150px;
  padding: 4px 8px;
  text-align: left;
  border-right: 1px solid var(--line);
}
.chart thead th,
.chart thead td {
  background: var(--surface);
}
.chart button {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  text-align: left;
  border: 0;
}
.chart i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
svg {
  display: block;
}
text {
  fill: #526174;
  font-size: 12px;
}
rect {
  cursor: pointer;
}
rect:focus-visible {
  outline: 3px solid var(--brand);
}
</style>
