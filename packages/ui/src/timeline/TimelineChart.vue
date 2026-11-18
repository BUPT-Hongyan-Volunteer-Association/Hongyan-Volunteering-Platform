<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { TimelineActivity, TimelineItem } from '@hongyan/contracts';
import { activityTypes } from '../activityDisplay';
import { localTime, palette } from './examples';

const props = defineProps<{
  rows: TimelineActivity[];
  start: number;
  end: number;
  unit: 'hour' | 'day' | 'week' | 'month';
  now?: number;
  selected?: string;
}>();
const emit = defineEmits<{ choose: [row: TimelineActivity, segment: TimelineItem] }>();
const scroller = ref<HTMLDivElement>();
const available = ref(0);
const nameWidth = computed(() => (available.value && available.value < 560 ? 106 : 148));
const columns = computed(() => {
  if (props.unit === 'hour') return 24;
  if (props.unit === 'day') return 6;
  if (props.unit === 'month') return Math.round((props.end - props.start) / 86400000);
  return 7;
});
const width = computed(() => {
  const minimum =
    props.unit === 'week'
      ? 56
      : props.unit === 'month'
        ? 36
        : props.unit === 'hour'
          ? available.value && available.value < 560
            ? 27
            : 52
          : 56;
  return Math.max(columns.value * minimum, available.value - nameWidth.value - 2);
});
const ticks = computed(() =>
  Array.from({ length: columns.value }, (_, i) => {
    const at = props.start + ((props.end - props.start) * i) / columns.value;
    const d = new Date(at + 8 * 3600000);
    const label =
      props.unit === 'week'
        ? '周' + '日一二三四五六'[d.getUTCDay()] + ' ' + d.getUTCDate()
        : props.unit === 'month'
          ? String(d.getUTCDate())
          : String(d.getUTCHours()).padStart(2, '0') + ':00';
    return { at, label, x: (i * width.value) / columns.value };
  }),
);
const selectedTime = computed(() => {
  for (const row of props.rows) {
    const s = row.segments.find((s) => s.occurrence_key === props.selected);
    if (s) return Math.max(props.start, Date.parse(s.starts_at));
  }
  return undefined;
});
const selectedCol = computed(() =>
  selectedTime.value === undefined
    ? -1
    : Math.floor(((selectedTime.value - props.start) / (props.end - props.start)) * columns.value),
);
const choices = ref<{ row: TimelineActivity; segments: TimelineItem[] }>();
const selectedRow = (row: TimelineActivity) =>
  row.segments.some((s) => s.occurrence_key === props.selected);
function x(time: number) {
  return Math.min(
    width.value,
    Math.max(0, ((time - props.start) * width.value) / (props.end - props.start)),
  );
}
function choose(row: TimelineActivity, s: TimelineItem) {
  choices.value = undefined;
  emit('choose', row, s);
}
const nowX = computed(() =>
  props.now !== undefined && props.start <= props.now && props.now < props.end
    ? x(props.now)
    : undefined,
);
function hit(event: MouseEvent, row: TimelineActivity) {
  const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const px = ((event.clientX - bounds.left) * width.value) / bounds.width;
  const exact = row.segments.find(
    (s) => px >= x(Date.parse(s.starts_at)) && px < x(Date.parse(s.ends_at)),
  );
  if (exact) return choose(row, exact);
  const segments = row.segments.filter((s) => {
    const left = x(Date.parse(s.starts_at)),
      right = x(Date.parse(s.ends_at));
    return Math.abs(px - (left + right) / 2) <= Math.max(22, (right - left) / 2);
  });
  if (segments.length === 1) choose(row, segments[0]);
  else if (segments.length > 1) choices.value = { row, segments };
}
function positionWindow() {
  if (!scroller.value || !available.value) return;
  if (props.unit === 'hour' || props.unit === 'month') {
    const first =
      selectedTime.value ??
      Math.min(...props.rows.flatMap((r) => r.segments.map((s) => Date.parse(s.starts_at))));
    const alignAt =
      props.unit === 'hour'
        ? props.start + Math.floor((first - props.start) / 10800000) * 10800000
        : first;
    scroller.value.scrollLeft = Number.isFinite(alignAt) ? x(alignAt) : 0;
  } else scroller.value.scrollLeft = 0;
}
const resize = new ResizeObserver(([entry]) => {
  if (entry.contentRect.width) {
    const firstLayout = !available.value;
    available.value = Math.floor(entry.contentRect.width);
    if (firstLayout) void nextTick(positionWindow);
  }
});
watch(
  () => [props.start, props.unit],
  async () => {
    await nextTick();
    positionWindow();
  },
);
watch(
  () => props.rows,
  () => {
    choices.value = undefined;
  },
);
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
                  v-if="unit !== 'hour' || available >= 560 || i % 3 === 0"
                  :x="unit === 'hour' || unit === 'day' ? t.x + 3 : t.x + width / columns / 2"
                  y="24"
                  :text-anchor="unit === 'hour' || unit === 'day' ? 'start' : 'middle'"
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
        <tr v-for="row in rows" :key="row.activity_id" :class="{ picked: selectedRow(row) }">
          <th scope="row">
            <button
              class="name-button"
              :aria-label="row.title"
              @click="choose(row, row.segments[0])"
            >
              <i :style="{ background: palette[row.color_index] }" /><span
                ><strong>{{ row.title }}</strong
                ><small
                  >{{ activityTypes[row.schedule_type]
                  }}{{ row.is_ongoing ? ' · 进行中' : '' }}</small
                ></span
              >
            </button>
          </th>
          <td>
            <svg
              :width="width"
              height="58"
              :aria-label="row.title + '的时段'"
              @click="hit($event, row)"
            >
              <line
                v-for="t in ticks"
                :key="t.at"
                :x1="t.x"
                :x2="t.x"
                y1="0"
                y2="100%"
                stroke="#e4e9f0"
                :stroke-dasharray="unit === 'hour' ? '3 3' : undefined"
              />
              <rect
                v-for="s in row.segments"
                :key="s.occurrence_key"
                tabindex="0"
                role="button"
                :aria-pressed="s.occurrence_key === selected"
                :aria-label="
                  row.title + ' ' + localTime(s.starts_at) + ' 至 ' + localTime(s.ends_at)
                "
                :x="x(Date.parse(s.starts_at))"
                :width="x(Date.parse(s.ends_at)) - x(Date.parse(s.starts_at))"
                y="50%"
                transform="translate(0 -12)"
                height="24"
                rx="3"
                :fill="palette[row.color_index]"
                :stroke="s.occurrence_key === selected ? '#F1C64B' : 'none'"
                stroke-width="2"
                @click.stop="choose(row, s)"
                @keydown.enter.prevent="choose(row, s)"
                @keydown.space.prevent="choose(row, s)"
              >
                <title>
                  {{ row.title }} · {{ localTime(s.starts_at) }} – {{ localTime(s.ends_at) }}
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
  <section v-if="choices" class="time-choices">
    <h3>选择时段</h3>
    <div class="page-actions">
      <button v-for="s in choices.segments" :key="s.occurrence_key" @click="choose(choices.row, s)">
        {{ localTime(s.starts_at) }} 至 {{ localTime(s.ends_at) }}
      </button>
    </div>
  </section>
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
.time-choices {
  padding: 12px;
  background: var(--surface);
}
</style>
