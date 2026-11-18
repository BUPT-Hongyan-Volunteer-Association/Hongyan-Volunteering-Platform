<script setup lang="ts">
import UiSelect from '../UiSelect.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TimelineActivity, TimelineActivityPage, TimelineItem } from '@hongyan/contracts';
import UiIcon from '../UiIcon.vue';
import { activityTypes, localDateTime, phaseOptions } from '../activityDisplay';
import { units, validDate, validUnit, dateWindow, shiftDate, windowLabel } from './window';
import ScheduleDatePicker from './ScheduleDatePicker.vue';
import TimelineChart from './TimelineChart.vue';
import {
  beijingDate,
  evaluatedAt,
  examplePage,
  localTime,
  palette,
  phaseLabels,
  standalone,
  statusLabels,
  type Scope,
} from './examples';

const props = defineProps<{ scope: Scope; showPersonalScope?: boolean }>();
const scopes = { public: '活动日程', mine: '活动日程', managed: '本人管理日程', all: '全院日程' };
const route = useRoute(),
  router = useRouter();
const media = window.matchMedia('(max-width: 700px)');
const mobile = ref(media.matches);
const page = ref<TimelineActivityPage>();
const loading = ref(false),
  error = ref('');
const detailHeading = ref<HTMLElement>();
const managed = computed(() => props.scope === 'managed' || props.scope === 'all');
const revision = computed(() =>
  managed.value && route.query.revision !== 'published' ? 'working' : 'published',
);
const unit = computed(() =>
  validUnit(route.query.unit) ? route.query.unit : mobile.value ? 'hour' : 'week',
);
const filterOpen = ref(false);
const chart = computed(() => (route.query.view || (mobile.value ? 'list' : 'chart')) === 'chart');
const date = computed(() =>
  validDate(route.query.date) ? route.query.date : evaluatedAt.slice(0, 10),
);
const range = computed(() => dateWindow(date.value, unit.value));
const start = computed(() => range.value.start),
  end = computed(() => range.value.end);
const periodLabel = computed(() => windowLabel(start.value, end.value, unit.value));
const arrows = computed(() =>
  unit.value === 'week'
    ? ['上一周', '下一周']
    : unit.value === 'month'
      ? ['上个月', '下个月']
      : ['前一天', '后一天'],
);
const shift = (direction: number) => set('date', shiftDate(date.value, unit.value, direction));
const filterCount = computed(
  () =>
    [
      'q',
      'campus',
      'phase',
      'status',
      'ongoing',
      ...(managed.value ? ['owner', 'pending'] : []),
    ].filter((k) => route.query[k]).length,
);
const rows = computed(() =>
  (page.value?.items ?? [])
    .filter(
      (r) =>
        (!route.query.q ||
          [r.title, r.activity_code].some((v) => v.includes(String(route.query.q)))) &&
        (!route.query.campus || route.query.campus === r.campus) &&
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
const fullMobileDetail = computed(
  () => mobile.value && selected.value && route.query.detail !== 'summary',
);
const actionNotice = ref(
  typeof window.history.state?.scheduleNotice === 'string'
    ? window.history.state.scheduleNotice
    : '',
);
if (actionNotice.value)
  window.history.replaceState({ ...window.history.state, scheduleNotice: null }, '');
watch([page, selected, () => route.query.item, () => route.query.slot], () => {
  if (!page.value || !route.query.item || selected.value) return;
  selectionMessage.value =
    route.query.slot !== undefined ? '所选时段已移出当前窗口' : '所选活动已移出当前筛选。';
  void router.replace({
    query: { ...route.query, item: undefined, slot: undefined, detail: undefined },
  });
});
const revisionOptions = [
  { value: 'working', label: '工作版本' },
  { value: 'published', label: '获批版本' },
];
const availableStates = computed(() =>
  Object.entries(statusLabels).filter(
    ([key]) => managed.value || ['published', 'cancelled', 'completed'].includes(key),
  ),
);
const statusOptions = computed(() => [
  { value: '', label: '所有状态' },
  ...availableStates.value.map(([value, label]) => ({ value, label })),
]);
const campusOptions = computed(() => [
  { value: '', label: '所有校区' },
  ...new Set(page.value?.items.map((r) => r.campus).filter((c): c is string => !!c)),
]);
const ownerOptions = computed(() => [
  { value: '', label: '所有负责人' },
  ...new Set(page.value?.items.map((r) => r.owner_display_name)),
]);
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
const listQuery = computed(() => ({
  q: route.query.q,
  phase: route.query.phase,
  status: route.query.status,
  campus: route.query.campus,
  ongoing: route.query.ongoing,
  date: date.value,
  unit: unit.value,
}));
function set(key: string, value: string) {
  selectionMessage.value = '';
  void router.push({ query: { ...route.query, [key]: value || undefined } });
}
const valueOf = (event: Event) => (event.target as HTMLInputElement).value;
let opener: Element | null = null;
async function choose(r: TimelineActivity, s: TimelineItem) {
  selectionMessage.value = '';
  opener = document.activeElement;
  await router.push({
    query: { ...route.query, item: r.activity_id, slot: s.occurrence_key, detail: undefined },
  });
  await nextTick();
  detailHeading.value?.focus();
}
async function close() {
  const query =
    mobile.value && selected.value
      ? { ...route.query, detail: 'summary' }
      : { ...route.query, item: undefined, slot: undefined, detail: undefined };
  await router.push({ query });
  await nextTick();
  const fallback = document.querySelector<HTMLElement>('.schedule-controls button');
  if (
    (opener instanceof HTMLElement || opener instanceof SVGElement) &&
    opener.isConnected &&
    opener.getClientRects().length
  )
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
  <div class="schedule-page">
    <RouterLink
      class="back-link"
      :to="
        scope === 'all'
          ? '/'
          : scope === 'managed'
            ? '/managed'
            : scope === 'mine'
              ? '/mine'
              : { path: '/', query: listQuery }
      "
    >
      <UiIcon name="ArrowLeft" />返回{{
        scope === 'all'
          ? '待办'
          : scope === 'managed'
            ? '我的管理活动'
            : scope === 'mine'
              ? '我的'
              : '公开活动列表'
      }}
    </RouterLink>
    <p v-if="actionNotice" class="notice" role="status">{{ actionNotice }}</p>
    <header class="page-heading schedule-heading">
      <div class="page-title">
        <h1>{{ scopes[scope] }}</h1>
        <span class="sample-label">示例日程 · 北京时间</span>
      </div>
      <div v-if="!fullMobileDetail" class="view-actions">
        <div class="segmented view-switch" role="group" aria-label="显示方式">
          <button :aria-pressed="!chart" @click="set('view', 'list')">
            <UiIcon name="List" />列表
          </button>
          <button :aria-pressed="chart" aria-label="时间轴" @click="set('view', 'chart')">
            <UiIcon name="Calendar" />日程
          </button>
        </div>
        <button
          v-if="mobile"
          class="filter-toggle"
          :aria-expanded="filterOpen"
          aria-controls="schedule-filters"
          @click="filterOpen = !filterOpen"
        >
          <UiIcon name="Filter" />筛选<span v-if="filterCount">（{{ filterCount }}）</span>
        </button>
      </div>
    </header>
    <template v-if="!fullMobileDetail">
      <nav
        v-if="showPersonalScope && (scope === 'mine' || scope === 'public')"
        class="scope-tabs section-nav"
        aria-label="日程范围"
      >
        <RouterLink :to="{ path: '/schedule', query: route.query }">全部活动</RouterLink>
        <RouterLink :to="{ path: '/mine/schedule', query: route.query }">我的日程</RouterLink>
      </nav>
      <div v-show="!mobile || filterOpen" class="schedule-filters" id="schedule-filters">
        <label class="search-field"
          ><UiIcon name="Search" /><span class="sr-only">搜索日程活动</span>
          <input
            type="search"
            :value="route.query.q || ''"
            placeholder="搜索活动名称或编号"
            @change="set('q', valueOf($event).trim())"
          />
        </label>
        <div class="schedule-field">
          <label for="schedule-campus">校区</label
          ><UiSelect
            id="schedule-campus"
            label="校区"
            :model-value="String(route.query.campus || '')"
            :options="campusOptions"
            @update:model-value="set('campus', $event)"
          />
        </div>
        <div class="schedule-field">
          <label for="schedule-phase">报名阶段</label
          ><UiSelect
            id="schedule-phase"
            label="报名阶段"
            :model-value="String(route.query.phase || '')"
            :options="phaseOptions"
            @update:model-value="set('phase', $event)"
          />
        </div>
        <div class="schedule-field">
          <label for="schedule-status">活动状态</label
          ><UiSelect
            id="schedule-status"
            label="活动状态"
            :model-value="String(route.query.status || '')"
            :options="statusOptions"
            @update:model-value="set('status', $event)"
          />
        </div>
        <label class="tick"
          ><input
            type="checkbox"
            :checked="!!route.query.ongoing"
            @change="set('ongoing', route.query.ongoing ? '' : '1')"
          />进行中</label
        >
        <template v-if="managed">
          <div class="schedule-field">
            <label for="schedule-revision">展示版本</label
            ><UiSelect
              id="schedule-revision"
              label="展示版本"
              :model-value="revision"
              :options="revisionOptions"
              @update:model-value="set('revision', $event)"
            />
          </div>
          <label class="tick"
            ><input
              type="checkbox"
              :checked="!!route.query.pending"
              @change="set('pending', route.query.pending ? '' : '1')"
            />待审核</label
          >
          <div class="schedule-field" v-if="scope === 'all'">
            <label for="schedule-owner">负责人</label
            ><UiSelect
              id="schedule-owner"
              label="负责人"
              :model-value="String(route.query.owner || '')"
              :options="ownerOptions"
              @update:model-value="set('owner', $event)"
            />
          </div>
        </template>
      </div>
      <div class="schedule-controls">
        <div class="date-nav">
          <button class="icon-button" :aria-label="arrows[0]" :title="arrows[0]" @click="shift(-1)">
            <UiIcon name="ArrowLeft" />
          </button>
          <ScheduleDatePicker
            :date="date"
            :period="periodLabel"
            :highlighted="!!selected && (unit === 'hour' || unit === 'day')"
            @select="set('date', $event)"
          />
          <button class="icon-button" :aria-label="arrows[1]" :title="arrows[1]" @click="shift(1)">
            <UiIcon name="ArrowRight" />
          </button>
          <button @click="set('date', beijingDate(Date.now()))">今天</button>
        </div>
        <div class="scale-control">
          <span id="time-scale-label">时间刻度</span>
          <div class="segmented scales" role="group" aria-labelledby="time-scale-label">
            <button
              v-for="(label, key) in units"
              :key="key"
              :aria-pressed="unit === key"
              @click="set('unit', key)"
            >
              {{ label }}
            </button>
          </div>
        </div>
      </div>
    </template>
    <p v-if="loading" class="notice" role="status">正在读取活动范围…</p>
    <p v-else-if="error" role="alert">{{ error }} <button @click="load">重新读取</button></p>
    <template v-else>
      <p v-if="selectionMessage" role="status" class="notice">{{ selectionMessage }}</p>
      <div v-if="!rows.length" class="empty-state">
        <UiIcon name="Calendar" />
        <p>该窗口和筛选条件下没有活动</p>
      </div>
      <div v-else class="schedule-view" :class="{ split: selected && !mobile }">
        <section v-show="!fullMobileDetail" aria-label="筛选结果">
          <div class="view-caption">
            <h2>活动计划</h2>
            <small
              >{{ rows.length }} 项 · 示例状态时刻 {{ localTime(page!.state_evaluated_at) }}</small
            >
          </div>
          <div v-show="chart">
            <TimelineChart
              :rows="rows"
              :unit="unit"
              :start="start"
              :end="end"
              :now="scope === 'all' ? undefined : Date.parse(page!.state_evaluated_at)"
              :selected="segment?.occurrence_key"
              @choose="choose"
            />
          </div>
          <ul v-show="!chart" class="schedule-list">
            <li
              v-for="r in rows"
              :key="r.activity_id"
              :class="{ picked: r.activity_id === selected?.activity_id }"
            >
              <button class="row-button" @click="choose(r, r.segments[0])">
                <i :style="{ background: palette[r.color_index] }" />{{ r.title }}
              </button>
              <p class="meta-line">
                {{ statusLabels[r.status] }} · {{ phaseLabels[r.registration_phase]
                }}{{ r.is_ongoing ? ' · 进行中' : '' }}{{ r.has_pending_review ? ' · 待审核' : '' }}
              </p>
              <div class="slot-list">
                <button
                  v-for="s in r.segments"
                  :key="s.occurrence_key"
                  class="compact"
                  @click="choose(r, s)"
                >
                  <UiIcon name="Clock" />{{ localTime(s.starts_at) }} – {{ localTime(s.ends_at) }}
                </button>
              </div>
            </li>
          </ul>
        </section>
        <aside v-if="selected && segment" class="schedule-detail" aria-label="时段详情">
          <div v-if="!mobile || fullMobileDetail" class="detail-bar">
            <strong>时段详情</strong
            ><button
              class="icon-button quiet"
              title="返回日程"
              aria-label="返回日程"
              @click="close"
            >
              <UiIcon :name="mobile ? 'Back' : 'Close'" />
            </button>
          </div>
          <div class="selected-title">
            <h2 tabindex="-1" ref="detailHeading">{{ selected.title }}</h2>
            <span class="state-chip">{{ phaseLabels[selected.registration_phase] }}</span>
            <span v-if="!mobile || fullMobileDetail" class="state-chip neutral">{{
              statusLabels[selected.status]
            }}</span>
          </div>
          <div v-if="mobile && !fullMobileDetail" class="summary-info">
            <p>
              <UiIcon name="Clock" />{{ localTime(segment.starts_at) }} 至
              {{ localTime(segment.ends_at) }}
            </p>
            <p>
              <UiIcon name="Location" />{{
                [selected.campus, selected.location].filter(Boolean).join(' · ')
              }}
            </p>
            <p>
              <UiIcon name="User" />{{ selected.owner_display_name }} · 名额
              {{ selected.capacity }} 人
            </p>
          </div>
          <dl v-else>
            <dt><UiIcon name="Calendar" />安排</dt>
            <dd>{{ activityTypes[selected.schedule_type] }}</dd>
            <dt><UiIcon name="Clock" />时段</dt>
            <dd>{{ localTime(segment.starts_at) }} 至 {{ localTime(segment.ends_at) }}</dd>
            <dt><UiIcon name="Location" />地点</dt>
            <dd>{{ [selected.campus, selected.location].filter(Boolean).join(' · ') }}</dd>
            <dt><UiIcon name="User" />负责人</dt>
            <dd>{{ selected.owner_display_name }}</dd>
            <dt><UiIcon name="Tickets" />名额</dt>
            <dd>{{ selected.capacity }} 人</dd>
            <template v-if="selected.registration_closes_at"
              ><dt><UiIcon name="Timer" />报名截止</dt>
              <dd>{{ localDateTime(selected.registration_closes_at) }}</dd></template
            >
            <template
              v-if="
                selected.is_ongoing &&
                Date.parse(segment.starts_at) <= Date.parse(page!.state_evaluated_at) &&
                Date.parse(page!.state_evaluated_at) < Date.parse(segment.ends_at)
              "
              ><dt>所选时段</dt>
              <dd>进行中</dd></template
            >
            <template v-if="managed"
              ><dt>所选版本</dt>
              <dd>{{ selected.schedule_revision }}</dd></template
            >
          </dl>
          <button
            v-if="mobile && !fullMobileDetail"
            class="primary summary-action"
            @click="choose(selected, segment)"
          >
            查看活动<UiIcon name="Right" />
          </button>
          <template v-else>
            <RouterLink
              class="button primary"
              v-if="scope === 'all' && selected.current_review_id"
              :to="{
                path: '/reviews/' + selected.current_review_id,
                state: { scheduleReturn: route.fullPath },
              }"
              >查看待审版本<UiIcon name="Right"
            /></RouterLink>
            <RouterLink
              class="button primary"
              v-if="scope === 'managed'"
              :to="{
                path: '/managed/' + selected.activity_id,
                state: { scheduleReturn: route.fullPath },
              }"
              >打开真实活动工作区<UiIcon name="Right"
            /></RouterLink>
            <RouterLink
              class="button primary"
              v-if="(scope === 'public' || scope === 'mine') && selected.activity_id !== standalone"
              :to="{
                path: '/activities/' + selected.activity_id,
                state: { scheduleReturn: route.fullPath },
              }"
              >查看真实获批详情<UiIcon name="Right"
            /></RouterLink>
          </template>
        </aside>
      </div>
    </template>
  </div>
</template>
<style scoped>
.schedule-page {
  position: relative;
}
.view-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.schedule-heading {
  border-bottom: 1px solid var(--line);
  padding-bottom: 16px;
  margin-bottom: 16px;
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--field-line);
  border-radius: var(--radius);
  overflow: hidden;
}
.segmented button {
  min-width: 42px;
  border: 0;
  border-radius: 0;
}
.segmented button + button {
  border-left: 1px solid var(--line);
}
.segmented button[aria-pressed='true'] {
  color: white;
  background: var(--brand);
}
.segmented button:focus-visible {
  outline-offset: -3px;
  outline: 2px solid var(--yellow);
}
.schedule-filters,
.schedule-controls,
.date-nav,
.detail-bar,
.view-caption {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.schedule-filters {
  align-items: flex-end;
  padding-block: 0 16px;
  border-bottom: 1px solid var(--line);
}
.search-field {
  width: min(100%, 220px);
}
.schedule-filters {
  --select-width: 7.25rem;
}
.schedule-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.schedule-field > label {
  font-size: 13px;
  color: var(--muted);
}
.tick {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  font-size: 14px;
}
.scale-control {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 14px;
}
.schedule-controls {
  justify-content: space-between;
  margin: 18px 0;
}
.date-nav .ui-icon {
  width: 15px;
  height: 15px;
}
.view-caption {
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}
.view-caption h2 {
  margin: 0;
  font-size: 16px;
}
.view-caption small {
  color: var(--muted);
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 26%);
  align-items: start;
  gap: 20px;
}
.schedule-detail {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0 16px 16px;
}
.detail-bar {
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding: 5px 0;
  margin-bottom: 14px;
}
.selected-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.selected-title h2 {
  margin: 0;
}
.schedule-detail .selected-title h2 {
  flex-basis: 100%;
}
.scope-tabs {
  margin-top: -12px;
  margin-bottom: 14px;
}
.summary-info {
  display: grid;
  gap: 4px;
  margin: 10px 0 12px;
}
.summary-info p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 14px;
}
.summary-info .ui-icon {
  width: 15px;
  color: var(--brand);
}
@media (max-width: 700px) {
  .schedule-detail .selected-title h2 {
    flex-basis: auto;
  }
  .scope-tabs {
    margin-top: 0;
    margin-bottom: 8px;
  }
}
.schedule-detail dl {
  grid-template-columns: 5.2em minmax(0, 1fr);
  gap: 9px 8px;
  font-size: 14px;
}
.schedule-detail dt {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.schedule-detail dt .ui-icon {
  align-self: start;
  margin-top: 3px;
  width: 15px;
  height: 15px;
}
.schedule-detail .summary-action,
.schedule-detail .button {
  width: 100%;
}
.schedule-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}
.schedule-list li {
  border-bottom: 1px solid var(--line);
  padding: 12px;
}
.schedule-list li.picked {
  background: var(--brand-tint);
}
.schedule-list .row-button {
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--ink);
}
.row-button i {
  width: 5px;
  height: 16px;
  border-radius: 3px;
}
.slot-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.slot-list button {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 700px) {
  .schedule-heading {
    display: grid;
    gap: 12px;
    margin-bottom: 10px;
  }
  .view-switch {
    justify-self: start;
  }
  .schedule-filters {
    clear: both;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .schedule-filters .platform-select,
  .search-field {
    width: 100%;
  }
  .search-field {
    grid-column: 1 / -1;
  }
  .tick {
    min-height: 44px;
  }
  .schedule-controls {
    gap: 12px;
    margin: 12px 0;
  }
  .date-nav {
    width: 100%;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 44px auto;
    align-items: center;
    gap: 4px;
  }
  .date-nav > button:last-child {
    padding-inline: 10px;
  }
  .scale-control {
    width: 100%;
    justify-content: space-between;
  }
  .scales button {
    min-width: 44px;
  }
  .view-caption {
    gap: 4px;
  }
  .view-caption small {
    font-size: 12px;
  }
  .schedule-detail {
    border: 0;
    padding: 14px 0 0;
    margin-top: 12px;
    border-top: 1px solid var(--line);
  }
}
</style>
