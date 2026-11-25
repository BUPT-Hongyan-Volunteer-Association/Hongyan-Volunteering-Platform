<script setup lang="ts">
import UiSelect from '../UiSelect.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getTimeline,
  type GetTimelineData,
  type TimelineActivity,
  type TimelineItem,
} from '@hongyan/contracts';
import StatusFilter from '../StatusFilter.vue';
import SegmentedControl from '../SegmentedControl.vue';
import UiIcon from '../UiIcon.vue';
import {
  activityTypes,
  localDate,
  localDateTime,
  localTime,
  phaseLabels,
  phaseOptions,
  statusLabels,
  timelineColors,
} from '../activityDisplay';
import { units, validDate, validUnit, dateWindow, shiftDate, windowLabel } from './window';
import { createScheduleRange, type RangeIntent } from './scheduleRange';
import {
  campusOptionsFor,
  ownerOptionsFor,
  revisionOptions,
  statusOptionsFor,
  unitArrows,
} from './scheduleOptions';
import ScheduleDatePicker from './ScheduleDatePicker.vue';
import TimelineChart from './TimelineChart.vue';

type Query = GetTimelineData['query'];
type LoadMode = Exclude<RangeIntent['kind'], 'focus'>;

const props = defineProps<{ scope: Query['scope']; showPersonalScope?: boolean }>();
const scopes = { public: '活动日程', mine: '活动日程', managed: '本人管理日程', all: '全院日程' };
const route = useRoute(),
  router = useRouter();
const media = window.matchMedia('(max-width: 700px)');
const mobile = ref(media.matches);
const detailHeading = ref<HTMLElement>();
const managed = computed(() => props.scope === 'managed' || props.scope === 'all');
const revision = computed<'working' | 'published'>(() =>
  managed.value && route.query.revision !== 'published' ? 'working' : 'published',
);
const unit = computed(() =>
  validUnit(route.query.unit) ? route.query.unit : mobile.value ? 'hour' : 'week',
);
const filterOpen = ref(false);
const chart = computed(() => (route.query.view || (mobile.value ? 'list' : 'chart')) === 'chart');
const date = computed(() =>
  validDate(route.query.date) ? route.query.date : localDate(Date.now()),
);
const locateOnEntry = computed(() => Object.keys(route.query).every(key => key === 'unit' || key === 'view'));
const range = computed(() => dateWindow(date.value, unit.value));
const start = computed(() => range.value.start),
  end = computed(() => range.value.end);
const periodLabel = computed(() => windowLabel(start.value, end.value, unit.value));
const arrows = computed(() => unitArrows(unit.value));
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
const filterValue = (name: string) => String(route.query[name] ?? '') || undefined;
const query = computed<Query>(() => ({
  scope: props.scope,
  revision_scope: revision.value,
  from: new Date(start.value).toISOString(),
  to: new Date(end.value).toISOString(),
  q: filterValue('q'),
  campus: filterValue('campus'),
  registration_phase: filterValue('phase') as Query['registration_phase'],
  status: filterValue('status') as Query['status'],
  is_ongoing: route.query.ongoing ? true : undefined,
  owner_account_id: filterValue('owner'),
  review_status: route.query.pending ? 'pending_review' : undefined,
}));

const pageSize = 20;
const readPage = async (page: number) => {
  const { data, response } = await getTimeline({
    query: { ...query.value, page, page_size: pageSize },
    throwOnError: true,
  });
  const rangeKey = response.headers.get('X-Timeline-Range');
  if (!rangeKey?.trim()) throw new Error('日程响应缺少范围摘要，请重新读取');
  return { ...data.data, rangeKey };
};

const schedule = createScheduleRange(readPage, {
  maxInFlight: 3,
  pageSize,
  window: () => ({
    from: new Date(start.value).toISOString(),
    to: new Date(end.value).toISOString(),
  }),
  selection: () => ({
    item: typeof route.query.item === 'string' ? route.query.item : undefined,
    slot: typeof route.query.slot === 'string' ? route.query.slot : undefined,
  }),
});
const pages = schedule.pages;
const rows = schedule.rows;
const total = schedule.total;
const hasMore = schedule.hasMore;
const evaluatedAt = schedule.evaluatedAt;
const loading = schedule.running;
const selection = schedule.selection;
const lastPage = computed(() => pages.value.at(-1));
const selected = computed(() =>
  selection.value.kind === 'kept' ? selection.value.activity : undefined,
);
const segment = computed(() => (selection.value.kind === 'kept' ? selection.value.slot : undefined));
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

const statusOptions = computed(() => statusOptionsFor(managed.value));
const campusOptions = computed(() => campusOptionsFor(String(route.query.campus || '')));
const ownerOptions = computed(() =>
  ownerOptionsFor(lastPage.value, String(route.query.owner || '')),
);
const error = ref('');
let lastMode: LoadMode = 'initial';
let pendingRefresh = false;
// 切换查询时立即撤下旧结果，等待中的新查询也计入读取状态。
// 计数是响应式的：行按钮按它呈禁用态，与「加载更多」在读取中禁用一致。
const switching = ref(0);

function clearSelection() {
  void router.replace({
    query: { ...route.query, item: undefined, slot: undefined, detail: undefined },
  });
}

/** 读取成功后才判选中失效：页面只按 kind 映射说明并清空 URL，不自己解析时段键。 */
function applySelection() {
  const state = selection.value;
  if (state.kind === 'kept' || state.kind === 'none') return;
  selectionMessage.value =
    state.kind === 'window-moved'
      ? '所选时段已移出当前窗口'
      : state.kind === 'schedule-updated'
        ? '所选时段已随安排更新失效，已回到日程'
        : '所选活动已移出当前筛选';
  clearSelection();
}

/** 选中活动不在已加载范围且还有更多页时，逐页补读，找到该活动或读完即停。 */
function needsBackfill() {
  const item = typeof route.query.item === 'string' ? route.query.item : undefined;
  return !!item && !rows.value.some((row) => row.activity_id === item) && hasMore.value;
}

async function load(mode: LoadMode) {
  if (mode !== 'initial' && (loading.value || switching.value > 0)) return;
  if (mode !== 'retry') lastMode = mode;
  if (mode === 'initial') switching.value += 1;
  error.value = '';
  let refreshAfter = false;
  try {
    let outcome = await schedule.run({ kind: mode });
    while (outcome.status === 'ok' && needsBackfill()) {
      const item = String(route.query.item);
      outcome = await schedule.run({ kind: 'focus', activityId: item });
      if (route.query.item === item) break;
    }
    if (outcome.status === 'aborted') return;
    if (outcome.status !== 'ok') {
      pendingRefresh = false;
      if (outcome.status === 'unstable') {
        error.value = pages.value.length ? '状态待刷新，请重试' : '日程仍在变化，请重新读取';
        return;
      }
      if (outcome.forbidden) {
        if (route.query.item) clearSelection();
        error.value = '当前身份无权查看该日程范围，请重新登录或返回';
      } else if (pages.value.length) {
        error.value = lastMode === 'more' ? '未能加载更多，请重试' : '状态待刷新，请重试';
      } else {
        error.value = outcome.message;
      }
      return;
    }
    const suggested = pages.value[0]?.suggested_date;
    if (mode === 'initial' && suggested && locateOnEntry.value) {
      await router.replace({ query: { ...route.query, date: suggested } });
      return;
    }
    applySelection();
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshAfter = true;
    }
  } finally {
    if (mode === 'initial') switching.value -= 1;
  }
  if (refreshAfter) void load('refresh');
}

const refresh = () => {
  if (document.visibilityState !== 'visible') return;
  if (loading.value) {
    pendingRefresh = true;
    return;
  }
  void load('refresh');
};
let timer: number | undefined;
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
  // 切换条件时忽略旧行的点击，避免把失效选段写回 URL。
  if (switching.value > 0) return;
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
watch(
  [() => JSON.stringify(query.value), () => props.scope, revision, locateOnEntry],
  ([, scope, version], [, previousScope, previousVersion]) => {
    selectionMessage.value = '';
    if (previousScope && (scope !== previousScope || version !== previousVersion) && route.query.item)
      clearSelection();
    void load('initial');
  },
  { immediate: true },
);
watch([() => route.query.item, () => route.query.slot], () => {
  if (!route.query.item || loading.value || error.value) return;
  if (selection.value.kind === 'kept') return;
  if (needsBackfill()) void load('refresh');
  else applySelection();
});
onMounted(() => {
  media.addEventListener('change', resized);
  window.addEventListener('keydown', keydown);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  timer = window.setInterval(refresh, 60000);
});
onUnmounted(() => {
  schedule.cancel();
  window.clearInterval(timer);
  media.removeEventListener('change', resized);
  window.removeEventListener('keydown', keydown);
  window.removeEventListener('focus', refresh);
  document.removeEventListener('visibilitychange', refresh);
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
        <span class="state-chip neutral">北京时间</span>
      </div>
      <div v-if="!fullMobileDetail" class="view-actions">
        <SegmentedControl class="view-switch" aria-label="显示方式">
          <button :aria-pressed="!chart" @click="set('view', 'list')">
            <UiIcon name="List" />列表
          </button>
          <button :aria-pressed="chart" aria-label="时间轴" @click="set('view', 'chart')">
            <UiIcon name="Calendar" />日程
          </button>
        </SegmentedControl>
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
          <StatusFilter v-if="scope === 'all'" label="审核状态" :model-value="route.query.pending ? 'pending' : 'all'"
            :options="{ all: '全部', pending: '待审核' }" @update:model-value="set('pending', $event === 'pending' ? '1' : '')" />
          <label v-else class="tick"
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
          <button v-if="scope !== 'all'" @click="set('date', localDate(Date.now()))">今天</button>
        </div>
        <div class="scale-control">
          <span id="time-scale-label">时间刻度</span>
          <SegmentedControl class="scales" aria-labelledby="time-scale-label">
            <button
              v-for="(label, key) in units"
              :key="key"
              :aria-pressed="unit === key"
              @click="set('unit', key)"
            >
              {{ label }}
            </button>
          </SegmentedControl>
        </div>
      </div>
    </template>
    <p v-if="loading && !pages.length" class="notice" role="status">正在读取活动日程…</p>
    <p v-else-if="error && !pages.length" role="alert">
      {{ error }} <button @click="load('initial')">重新读取</button>
    </p>
    <template v-else>
      <p v-if="error" class="notice" role="status">
        {{ error }}
        <button @click="load('retry')">重试</button>
      </p>
      <p v-if="selectionMessage" role="status" class="notice">{{ selectionMessage }}</p>
      <div v-if="!rows.length" class="empty-state">
        <UiIcon name="Calendar" />
        <p>该窗口和筛选条件下没有活动</p>
        <button v-if="lastPage?.suggested_date" @click="set('date', lastPage.suggested_date)">
          查看 {{ lastPage.suggested_date }} 的活动
        </button>
      </div>
      <div
        v-else
        class="schedule-view"
        :class="{ split: selected && !mobile }"
        :aria-busy="loading"
      >
        <section v-show="!fullMobileDetail" aria-label="筛选结果">
          <div class="view-caption">
            <h2>活动计划</h2>
            <small
              >{{ total }} 项<template v-if="hasMore"
                >（已显示 {{ rows.length }}）</template
              ><template v-if="scope !== 'all'">
                · 状态时刻 {{ localTime(evaluatedAt) }}</template
              ></small
            >
          </div>
          <div v-show="chart">
            <TimelineChart
              :rows="rows"
              :unit="unit"
              :start="start"
              :end="end"
              :now="managed ? undefined : Date.parse(evaluatedAt)"
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
              <button
                class="row-button"
                :disabled="switching > 0"
                @click="choose(r, r.segments[0])"
              >
                <i :style="{ background: timelineColors[r.color_index] }" />{{ r.title }}
              </button>
              <p class="meta-line">
                {{ statusLabels[r.status] }} · {{ phaseLabels[r.registration_phase]
                }}{{ r.is_ongoing ? ' · 进行中' : '' }}{{ r.has_pending_review ? ' · 待审核' : ''
                }}{{ r.has_planned_overlap ? ' · 与本人其他活动时间重叠' : '' }}
              </p>
              <div class="slot-list">
                <button
                  v-for="s in r.segments"
                  :key="s.occurrence_key"
                  class="compact"
                  :disabled="switching > 0"
                  @click="choose(r, s)"
                >
                  <UiIcon name="Clock" />{{ localTime(s.starts_at) }} – {{ localTime(s.ends_at) }}
                </button>
              </div>
            </li>
          </ul>
          <div v-if="hasMore" class="page-actions schedule-more">
            <button :disabled="loading" @click="load('more')">
              加载更多（剩余 {{ total - rows.length }} 项）
            </button>
          </div>
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
                Date.parse(segment.starts_at) <= Date.parse(evaluatedAt) &&
                Date.parse(evaluatedAt) < Date.parse(segment.ends_at)
              "
              ><dt>所选时段</dt>
              <dd>进行中</dd></template
            >
            <template v-if="segment.has_planned_overlap"
              ><dt>计划提示</dt>
              <dd>与本人其他已录取活动的计划时段重叠</dd></template
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
            <RouterLink v-if="scope === 'all'" class="button"
              :to="'/manage/teams/' + selected.activity_id">查看活动团队</RouterLink>
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
              v-if="scope === 'public' || scope === 'mine'"
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
.schedule-more {
  margin-top: 12px;
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
.schedule-list .row-button:disabled {
  color: #647186;
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
