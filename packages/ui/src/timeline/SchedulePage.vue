<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TimelineActivity, TimelineActivityPage, TimelineItem } from '@hongyan/contracts';
import TimelineChart from './TimelineChart.vue';
import {
  beijingDate,
  evaluatedAt,
  examplePage,
  localTime,
  phaseLabels,
  standalone,
  statusLabels,
  type Scope,
} from './examples';

const props = defineProps<{ scope: Scope }>();
const scopes = { public: '全部活动', mine: '我的日程', managed: '本人管理日程', all: '全院日程' };
const route = useRoute(),
  router = useRouter();
const media = window.matchMedia('(max-width: 640px)');
const mobile = ref(media.matches);
const page = ref<TimelineActivityPage>();
const loading = ref(false),
  error = ref('');
const detailHeading = ref<HTMLElement>();
const managed = computed(() => props.scope === 'managed' || props.scope === 'all');
const revision = computed(() =>
  managed.value && route.query.revision !== 'published' ? 'working' : 'published',
);
const hour = computed(() => (route.query.unit || (mobile.value ? 'hour' : 'week')) === 'hour');
const chart = computed(() => (route.query.view || (mobile.value ? 'list' : 'chart')) === 'chart');
const date = computed(() => {
  const d = String(route.query.date || evaluatedAt.slice(0, 10));
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00+08:00'))
    ? d
    : evaluatedAt.slice(0, 10);
});
const day = 86400000;
const start = computed(() => {
  const midnight = Date.parse(date.value + 'T00:00:00+08:00');
  return hour.value
    ? midnight
    : midnight - ((new Date(date.value + 'T00:00:00Z').getUTCDay() + 6) % 7) * day;
});
const end = computed(() => start.value + (hour.value ? 1 : 7) * day);
const rows = computed(() =>
  (page.value?.items ?? [])
    .filter(
      (r) =>
        (!route.query.phase || route.query.phase === r.registration_phase) &&
        (!route.query.status || route.query.status === r.status) &&
        (!route.query.ongoing || r.is_ongoing) &&
        (!managed.value || !route.query.pending || r.has_pending_review) &&
        (!managed.value || !route.query.owner || r.owner_display_name === route.query.owner),
    )
    .map((r) => ({
      ...r,
      segments: r.segments.filter(
        (s) => Date.parse(s.starts_at) < end.value && Date.parse(s.ends_at) > start.value,
      ),
    }))
    .filter((r) => r.segments.length),
);
const activity = computed(() => rows.value.find((r) => r.activity_id === route.query.item));
const segment = computed(() =>
  route.query.slot === undefined
    ? activity.value?.segments[0]
    : activity.value?.segments.find((s) => s.occurrence_key === route.query.slot),
);
const selected = computed(() => (segment.value ? activity.value : undefined));
const selectionMessage = ref('');
watch([page, selected, () => route.query.item, () => route.query.slot], () => {
  if (!page.value || !route.query.item || selected.value) return;
  selectionMessage.value =
    route.query.slot !== undefined ? '所选时段已移出当前窗口' : '所选活动已移出当前筛选。';
  void router.replace({ query: { ...route.query, item: undefined, slot: undefined } });
});
const availableStates = computed(() =>
  Object.entries(statusLabels).filter(
    ([key]) => managed.value || ['published', 'cancelled', 'completed'].includes(key),
  ),
);
const owners = computed(() => [...new Set(page.value?.items.map((r) => r.owner_display_name))]);
let request = 0;
async function load() {
  const n = ++request;
  loading.value = true;
  error.value = '';
  page.value = undefined;
  try {
    const data = await examplePage(props.scope, revision.value);
    if (n === request) page.value = data;
  } catch (e) {
    if (n === request) error.value = e instanceof Error ? e.message : '读取活动范围失败';
  } finally {
    if (n === request) loading.value = false;
  }
}
function set(key: string, value: string) {
  selectionMessage.value = '';
  void router.push({ query: { ...route.query, [key]: value || undefined } });
}
const valueOf = (event: Event) => (event.target as HTMLInputElement).value;
let opener: Element | null = null;
async function choose(r: TimelineActivity, s: TimelineItem) {
  selectionMessage.value = '';
  opener = document.activeElement;
  await router.push({ query: { ...route.query, item: r.activity_id, slot: s.occurrence_key } });
  await nextTick();
  detailHeading.value?.focus();
}
async function close() {
  await router.push({ query: { ...route.query, item: undefined, slot: undefined } });
  await nextTick();
  const fallback = document.querySelector<HTMLElement>('.schedule-controls button');
  if ((opener instanceof HTMLElement || opener instanceof SVGElement) && opener.isConnected)
    opener.focus();
  else fallback?.focus();
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && route.query.item) void close();
}
function resized() {
  mobile.value = media.matches;
}
watch([() => props.scope, revision], load, { immediate: true });
onMounted(() => {
  media.addEventListener('change', resized);
  window.addEventListener('keydown', keydown);
  window.addEventListener('focus', load);
});
onUnmounted(() => {
  request++;
  media.removeEventListener('change', resized);
  window.removeEventListener('keydown', keydown);
  window.removeEventListener('focus', load);
});
</script>
<template>
  <RouterLink
    :to="
      scope === 'all' ? '/' : scope === 'managed' ? '/managed' : scope === 'mine' ? '/mine' : '/'
    "
    >返回{{
      scope === 'all'
        ? '待办'
        : scope === 'managed'
          ? '我的管理活动'
          : scope === 'mine'
            ? '我的'
            : '公开活动列表'
    }}</RouterLink
  >
  <h1>{{ scopes[scope] }}</h1>
  <p class="sample-label">示例日程 · 北京时间</p>
  <template v-if="!mobile || !selected">
    <div class="schedule-controls">
      <button :aria-pressed="!chart" @click="set('view', 'list')">列表</button
      ><button :aria-pressed="chart" @click="set('view', 'chart')">时间轴</button>
      <label
        >粒度
        <select
          aria-label="粒度"
          :value="hour ? 'hour' : 'week'"
          @change="set('unit', valueOf($event))"
        >
          <option value="hour">小时</option>
          <option value="week">周</option>
        </select></label
      >
      <label
        >查看日期 <input type="date" :value="date" @change="set('date', valueOf($event))"
      /></label>
      <button @click="set('date', beijingDate(Date.now()))">今天</button>
    </div>
    <div class="schedule-controls">
      <label
        >报名阶段
        <select
          aria-label="报名阶段"
          :value="route.query.phase || ''"
          @change="set('phase', valueOf($event))"
        >
          <option value="">全部</option>
          <option v-for="(label, key) in phaseLabels" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >活动状态
        <select
          aria-label="活动状态"
          :value="route.query.status || ''"
          @change="set('status', valueOf($event))"
        >
          <option value="">全部</option>
          <option v-for="[key, label] in availableStates" :key="key" :value="key">
            {{ label }}
          </option>
        </select></label
      >
      <label
        ><input
          type="checkbox"
          :checked="!!route.query.ongoing"
          @change="set('ongoing', route.query.ongoing ? '' : '1')"
        />进行中</label
      >
      <template v-if="managed">
        <label
          >展示版本
          <select
            aria-label="展示版本"
            :value="revision"
            @change="set('revision', valueOf($event))"
          >
            <option value="working">工作版本</option>
            <option value="published">获批版本</option>
          </select></label
        >
        <label
          ><input
            type="checkbox"
            :checked="!!route.query.pending"
            @change="set('pending', route.query.pending ? '' : '1')"
          />待审核</label
        >
        <label v-if="scope === 'all'"
          >负责人
          <select
            aria-label="负责人"
            :value="route.query.owner || ''"
            @change="set('owner', valueOf($event))"
          >
            <option value="">全部</option>
            <option v-for="owner in owners" :key="owner">{{ owner }}</option>
          </select></label
        >
      </template>
    </div>
    <p>
      {{ beijingDate(start) }} 至 {{ beijingDate(end - 1) }} · 示例状态时刻
      {{ localTime(evaluatedAt) }}
    </p>
  </template>
  <p v-if="loading" role="status">正在读取活动范围…</p>
  <p v-else-if="error" role="alert">{{ error }} <button @click="load">重新读取</button></p>
  <template v-else>
    <p v-if="selectionMessage" role="status">{{ selectionMessage }}</p>
    <p v-if="!rows.length">该窗口和筛选条件下没有活动</p>
    <div v-else class="schedule-view" :class="{ split: selected && !mobile }">
      <section v-show="!mobile || !selected" aria-label="筛选结果">
        <div v-show="chart">
          <TimelineChart
            :rows="rows"
            :hour="hour"
            :start="start"
            :end="end"
            :now="Date.parse(page!.state_evaluated_at)"
            :selected="segment?.occurrence_key"
            @choose="choose"
          />
        </div>
        <ul v-show="!chart" class="schedule-list">
          <li v-for="r in rows" :key="r.activity_id">
            <button @click="choose(r, r.segments[0])">{{ r.title }}</button>
            <span
              >{{ statusLabels[r.status] }} · {{ phaseLabels[r.registration_phase]
              }}{{ r.is_ongoing ? ' · 进行中' : ''
              }}{{ r.has_pending_review ? ' · 待审核' : '' }}</span
            >
            <small>{{ r.segments.map((s) => localTime(s.starts_at)).join('、') }}</small>
          </li>
        </ul>
      </section>
      <aside v-if="selected && segment" class="schedule-detail" aria-label="时段详情">
        <button @click="close">返回日程</button>
        <h2 tabindex="-1" ref="detailHeading">{{ selected.title }}</h2>
        <dl>
          <dt>时段</dt>
          <dd>{{ localTime(segment.starts_at) }} 至 {{ localTime(segment.ends_at) }}</dd>
          <dt>地点</dt>
          <dd>{{ selected.location }}</dd>
          <dt>负责人</dt>
          <dd>{{ selected.owner_display_name }}</dd>
          <dt>名额</dt>
          <dd>{{ selected.capacity }} 人</dd>
          <dt>活动状态</dt>
          <dd>{{ statusLabels[selected.status] }}{{ selected.is_ongoing ? ' · 进行中' : '' }}</dd>
          <dt>报名</dt>
          <dd>{{ phaseLabels[selected.registration_phase] }}</dd>
          <dt>所选版本</dt>
          <dd>{{ selected.schedule_revision }}</dd>
        </dl>
        <RouterLink
          v-if="scope === 'all' && selected.current_review_id"
          :to="'/reviews/' + selected.current_review_id"
          >查看待审版本</RouterLink
        >
        <RouterLink v-if="scope === 'managed'" :to="'/managed/' + selected.activity_id"
          >打开真实活动工作区</RouterLink
        >
        <RouterLink
          v-if="(scope === 'public' || scope === 'mine') && selected.activity_id !== standalone"
          :to="'/activities/' + selected.activity_id"
          >查看真实获批详情</RouterLink
        >
      </aside>
    </div>
  </template>
</template>
<style scoped>
.schedule-controls {
  display: flex;
  align-items: center;
  gap: 8px 16px;
  flex-wrap: wrap;
  margin: 8px 0;
}
button[aria-pressed='true'] {
  background: var(--brand);
  color: white;
}
.schedule-view section,
.schedule-view {
  min-width: 0;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 32%);
  gap: 16px;
}
.schedule-detail {
  border-left: 2px solid var(--brand);
  padding: 0 16px;
}
.schedule-detail dl {
  grid-template-columns: 4em minmax(0, 1fr);
}
.schedule-list {
  padding: 0;
  list-style: none;
}
.schedule-list li {
  display: grid;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  padding: 8px 0;
}
.schedule-list button {
  justify-self: start;
}
.schedule-list small {
  color: var(--muted);
}
</style>
