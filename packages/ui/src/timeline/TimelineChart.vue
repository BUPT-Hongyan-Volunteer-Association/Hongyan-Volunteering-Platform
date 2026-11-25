<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { TimelineActivity } from '@hongyan/contracts';
import { serviceDateText, serviceWindow } from '@hongyan/contracts/activity';
import { timelineColors } from '../activityDisplay';
import type { TimeUnit } from './window';

const props = defineProps<{
  rows: TimelineActivity[];
  start: number;
  end: number;
  unit: TimeUnit;
  now?: number;
  selected?: string;
}>();
const emit = defineEmits<{ choose: [row: TimelineActivity] }>();
const day = 86400000;
const scroller = ref<HTMLDivElement>();
const available = ref(0);
const nameWidth = computed(() => available.value && available.value < 560 ? 106 : 148);
const columns = computed(() => (props.end - props.start) / day);
const width = computed(() => Math.max(columns.value * (props.unit === 'month' ? 44 : 56), available.value - nameWidth.value - 2));
const ticks = computed(() => Array.from({ length: columns.value }, (_, i) => {
  const at = props.start + i * day;
  const date = new Date(at + 8 * 3600000);
  const label = props.unit === 'week' ? '周' + '日一二三四五六'[date.getUTCDay()] + ' ' + date.getUTCDate()
    : String(date.getUTCDate());
  return { at, label, x: i * width.value / columns.value };
}));
function x(time: number) {
  return Math.min(width.value, Math.max(0, (time - props.start) * width.value / (props.end - props.start)));
}
const bars = computed(() => props.rows.map(row => {
  const period = serviceWindow(row)!;
  const left = x(period.start);
  return { row, left, width: x(period.end) - left };
}));
const selectedCol = computed(() => {
  const bar = bars.value.find(b => b.row.activity_id === props.selected);
  return bar ? Math.floor(bar.left / width.value * columns.value) : -1;
});
const nowX = computed(() => props.now !== undefined && props.now >= props.start && props.now < props.end
  ? (Math.floor((props.now - props.start) / day) + 0.5) * width.value / columns.value : undefined);
function positionWindow() {
  if (!scroller.value) return;
  const left = bars.value.find(b => b.row.activity_id === props.selected)?.left ?? Math.min(...bars.value.map(b => b.left));
  scroller.value.scrollLeft = Number.isFinite(left) ? left : 0;
}
const resize = new ResizeObserver(([entry]) => {
  if (!entry.contentRect.width) return;
  const first = !available.value;
  available.value = Math.floor(entry.contentRect.width);
  if (first) void nextTick(positionWindow);
});
watch(() => [props.start, props.unit], () => nextTick(positionWindow));
onMounted(() => {
  if (scroller.value) resize.observe(scroller.value);
});
onUnmounted(() => resize.disconnect());
</script>
<template>
  <div
    class="chart-scroll"
    ref="scroller"
    tabindex="0"
    aria-label="可横向滚动的活动时间轴"
    :style="{ '--name-width': nameWidth + 'px' }"
  >
    <table class="chart">
      <thead>
        <tr>
          <th scope="col">活动名称</th>
          <td>
            <svg :width="width" height="38" role="img" aria-label="时间刻度">
              <g v-for="(t, i) in ticks" :key="t.at">
                <rect
                  v-if="i === selectedCol"
                  :x="t.x"
                  y="0"
                  :width="width / columns"
                  height="38"
                  fill="#fff7d6"
                />
                <text
                  :x="t.x + width / columns / 2"
                  y="24"
                  text-anchor="middle"
                >
                  {{ t.label }}
                </text>
              </g>
              <path
                v-if="nowX !== undefined"
                :d="'M' + (nowX - 4) + ' 32 h8 l-4 6 z'"
                fill="#003399"
              />
            </svg>
          </td>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ row, left, width: barWidth } in bars" :key="row.activity_id" :class="{ picked: selected === row.activity_id }">
          <th scope="row">
            <button
              class="name-button"
              :aria-label="row.title"
              @click="emit('choose', row)"
            >
              <i :style="{ background: timelineColors[row.color_index] }" /><span
                ><strong>{{ row.title }}</strong
                ><small>{{ serviceDateText(row) }}{{ row.is_ongoing ? ' · 进行中' : '' }}{{ row.has_pending_review ? ' · 待审核' : '' }}</small
                ></span
              >
            </button>
          </th>
          <td>
            <svg
              :width="width"
              height="58"
              :aria-label="row.title + '的服务日期'"
            >
              <line
                v-for="t in ticks"
                :key="t.at"
                :x1="t.x"
                :x2="t.x"
                y1="0"
                y2="100%"
                stroke="#e4e9f0"
              />
              <rect
                tabindex="0"
                role="button"
                :aria-pressed="row.activity_id === selected"
                :aria-label="row.title + ' ' + serviceDateText(row)"
                :x="left"
                :width="barWidth"
                y="50%"
                transform="translate(0 -12)"
                height="24"
                rx="3"
                :fill="timelineColors[row.color_index]"
                :stroke="row.activity_id === selected ? '#F1C64B' : 'none'"
                stroke-width="2"
                @click.stop="emit('choose', row)"
                @keydown.enter.prevent="emit('choose', row)"
                @keydown.space.prevent="emit('choose', row)"
              >
                <title>
                  {{ row.title }} · {{ serviceDateText(row) }}
                </title>
              </rect>
              <line
                v-if="nowX !== undefined"
                class="now-line"
                :x1="nowX"
                :x2="nowX"
                y1="0"
                y2="100%"
                stroke="#003399"
                pointer-events="none"
              />
            </svg>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.chart-scroll {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
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
.chart tbody tr:last-child > * {
  border-bottom: 0;
}
.chart th {
  position: sticky;
  z-index: 1;
  left: 0;
  background: white;
  min-width: var(--name-width);
  max-width: var(--name-width);
  width: var(--name-width);
  border-right: 1px solid var(--line);
  text-align: left;
}
.chart thead th,
.chart thead td {
  background: var(--surface);
}
.chart thead th {
  padding: 0 10px;
  color: var(--muted);
  font-size: 13px;
}
.name-button {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  min-height: 58px;
  gap: 8px;
  border: 0;
  border-radius: 0;
  padding: 7px 10px;
  background: transparent;
  text-align: left;
  color: var(--ink);
}
.name-button i {
  width: 5px;
  height: 22px;
  border-radius: 3px;
  flex: none;
}
.name-button strong,
.name-button small {
  display: block;
  overflow-wrap: anywhere;
}
.name-button strong {
  font-size: 14px;
  font-weight: 600;
}
.name-button small {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.chart tbody td {
  position: relative;
}
.chart tbody td > svg {
  position: absolute;
  inset: 0 auto auto 0;
  height: 100%;
}
.picked > th,
.picked > td {
  background: var(--brand-tint);
}
svg {
  display: block;
}
text {
  fill: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
rect[role='button'] {
  cursor: pointer;
}
rect:focus-visible {
  outline: 2px solid var(--brand);
}
@media (max-width: 700px) {
  rect[role='button'] {
    height: 44px;
    transform: translateY(-22px);
  }
}
</style>
