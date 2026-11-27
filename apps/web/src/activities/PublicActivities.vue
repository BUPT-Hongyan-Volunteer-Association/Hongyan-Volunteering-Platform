<script setup lang="ts">
import { activityBounds, serviceDates, serviceDateText } from '@hongyan/contracts/activity';
import { hasStudentAccess } from '../identity';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import {
  ApiError,
  listActivities,
  getActivity,
  type Activity,
  type Profile,
  type Registration,
} from '@hongyan/contracts';
import { dateWindow, validDate, validUnit, windowLabel } from '@hongyan/ui/timeWindow';
import {
  activityPrimaryStatus, localDate,
  phaseLabels,
  phaseOptions,
} from '@hongyan/ui/activityDisplay';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import ActivityDetail from './ActivityDetail.vue';
import ServiceCalendar from '@hongyan/ui/ServiceCalendar.vue';
import { pageNumber } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';

defineProps<{ profile: Profile }>();
const route = useRoute(),
  router = useRouter();
const rows = ref<Activity[]>([]),
  detail = ref<Activity>(),
  total = ref(0),
  pageSize = ref(20),
  busy = ref(true),
  error = ref('');
const search = ref('');
const filtersOpen = ref(false);
const cards = computed(() => rows.value.map(row => ({ row, firstDay: serviceDates(row.schedule).duration_start_date })));
const page = computed(() => pageNumber(route.query.page));
const selectedDay = computed(() => (validDate(route.query.date) ? route.query.date : ''));
const unit = computed(() => (validUnit(route.query.unit) ? route.query.unit : 'day'));
const range = computed(() =>
  selectedDay.value ? dateWindow(selectedDay.value, unit.value) : undefined,
);
const campus = computed(() => (typeof route.query.campus === 'string' ? route.query.campus : ''));
const publicStatuses = [
  { value: 'published', label: '已发布' },
  { value: 'completed', label: '已结束' },
  { value: 'cancelled', label: '已取消' },
];
const phase = computed(() =>
  Object.hasOwn(phaseLabels, String(route.query.phase))
    ? (route.query.phase as keyof typeof phaseLabels)
    : undefined,
);
const status = computed(() =>
  route.query.status === 'completed' || route.query.status === 'cancelled'
    ? route.query.status
    : 'published',
);
const filtered = computed(
  () =>
    !!(
      route.query.q ||
      campus.value ||
      phase.value ||
      selectedDay.value ||
      route.query.ongoing ||
      status.value !== 'published'
    ),
);
const listQuery = computed(() => ({
  ...route.query,
  item: undefined,
  slot: undefined,
  detail: undefined,
  view: undefined,
}));
let serial = 0;
let scrollPosition = 0;
const rememberScroll = () => {
  scrollPosition = window.scrollY;
};
function filter(changes: LocationQueryRaw) {
  scrollPosition = 0;
  return router.push({ path: '/', query: { ...listQuery.value, ...changes, page: undefined } });
}
async function load(keepDetail = false) {
  const index = ++serial;
  busy.value = true;
  error.value = '';
  if (!keepDetail) { detail.value = undefined; rows.value = []; }
  if (!keepDetail) search.value = String(route.query.q ?? '');
  try {
    if (route.params.id) {
      const response = await getActivity({
        path: { id: String(route.params.id) },
        throwOnError: true,
      });
      if (index === serial) detail.value = response.data.data;
    } else {
      const response = await listActivities({
        query: {
          scope: 'public',
          page: page.value,
          q: search.value || undefined,
          status: status.value,
          campus: campus.value || undefined,
          registration_phase: phase.value,
          is_ongoing: route.query.ongoing ? true : undefined,
          from: range.value && new Date(range.value.start).toISOString(),
          to: range.value && new Date(range.value.end).toISOString(),
        },
        throwOnError: true,
      });
      if (index === serial) {
        rows.value = response.data.data.items;
        total.value = response.data.data.total;
        pageSize.value = response.data.data.page_size;
      }
    }
  } catch (e) {
    if (index === serial) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0))
        detail.value = undefined;
      error.value = e instanceof Error ? e.message : '读取失败';
    }
  } finally {
    if (index === serial) {
      busy.value = false;
      await nextTick();
      if (index === serial && !keepDetail) window.scrollTo(0, route.params.id ? 0 : scrollPosition);
    }
  }
}
function applied(records: Registration[]) {
  if (!detail.value || !records.length || records.some(record => record.activity_id !== detail.value?.id)) return;
  const own = new Map((detail.value.my_registrations ?? []).map(row => [row.id, row]));
  for (const record of records) own.set(record.id, record);
  detail.value = { ...detail.value, my_registrations: [...own.values()], my_registration_status: records[0].status };
  void load(true);
}
function refreshDetail() {
  void load(true);
}
watch(
  () => route.fullPath,
  () => load(),
  { immediate: true },
);
// Re-read at the next server-evaluated boundary even if the student keeps this tab open.
watch([detail, rows], ([current, list], _, cleanup) => {
  // A currently hidden activity can enter a time-based list filter while the page stays open.
  let delay = !current && (phase.value || route.query.ongoing) ? 60_000 : Infinity;
  for (const activity of current ? [current] : list) {
    if (!activity.state_evaluated_at || activity.status !== 'published') continue;
    const now = Date.parse(activity.state_evaluated_at);
    const bounds = activityBounds(activity.schedule);
    const boundaries = [Date.parse(activity.registration_opens_at ?? ''), Date.parse(activity.registration_closes_at ?? ''), bounds?.start, bounds?.end];
    for (const at of boundaries) if (at !== undefined && at > now) delay = Math.min(delay, at - now);
  }
  if (delay === Infinity) return;
  const timer = window.setTimeout(() => {
    if (document.visibilityState === 'visible') refreshDetail();
  }, Math.min(2147483647, delay));
  cleanup(() => window.clearTimeout(timer));
});
function onVisibilityChange() {
  if (document.visibilityState === 'visible') refreshDetail();
}
onMounted(() => {
  window.addEventListener('focus', refreshDetail);
  document.addEventListener('visibilitychange', onVisibilityChange);
});
onUnmounted(() => {
  serial++;
  window.removeEventListener('focus', refreshDetail);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
const inputValue = (e: Event) => (e.target as HTMLInputElement).value;
</script>
<template>
  <template v-if="route.params.id">
    <p v-if="detail && error" role="alert">
      {{ error }} <button @click="refreshDetail">重新读取详情</button>
    </p>
    <ActivityDetail
      v-if="detail"
      :activity="detail"
      :key="detail.id"
      :refreshing="busy" :student="profile.student" @refresh="refreshDetail"
      @applied="applied"
      :show-registrations="hasStudentAccess(profile)"
    />
    <template v-else>
      <RouterLink class="back-link" :to="{ path: '/', query: listQuery }"
        ><UiIcon name="ArrowLeft" />返回活动列表</RouterLink
      >
      <h1>活动详情</h1>
      <p v-if="busy" role="status">正在读取…</p>
      <p v-else-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
    </template>
  </template>
  <template v-else>
    <header class="page-heading discover-heading">
      <h1>活动发现</h1>
    </header>
    <div class="discovery">
      <section class="results" aria-label="公开活动">
        <div class="filters">
          <form
            class="search-form"
            role="search"
            @submit.prevent="filter({ q: search.trim() || undefined })"
          >
            <label class="search-field"
              ><UiIcon name="Search" /><span class="sr-only">查找活动</span>
              <input
                type="search"
                placeholder="搜索活动名称或编号"
                v-model="search"
                @search="!search && filter({ q: undefined })"
              /> </label
            ><button class="primary">搜索</button>
          </form>
          <button
            class="mobile-filter quiet compact"
            :aria-expanded="filtersOpen"
            aria-controls="activity-filters"
            @click="filtersOpen = !filtersOpen"
          >
            <UiIcon name="Filter" />筛选<span
              v-if="campus || phase || selectedDay || route.query.ongoing || status !== 'published'"
              >（已设置）</span
            ><UiIcon name="ArrowDown" />
          </button>
          <div id="activity-filters" class="filter-row" :class="{ opened: filtersOpen }">
            <label
              >校区<input
                type="text"
                class="campus-filter"
                placeholder="全部校区"
                :value="campus"
                @change="filter({ campus: inputValue($event).trim() || undefined })"
            /></label>
            <label
              >报名阶段<UiSelect
                label="报名阶段"
                :model-value="phase || ''"
                :options="phaseOptions"
                @update:model-value="filter({ phase: $event || undefined })"
            /></label>
            <label
              >活动状态<UiSelect
                label="活动状态"
                :model-value="status"
                :options="publicStatuses"
                @update:model-value="filter({ status: $event })"
            /></label>
            <label class="ongoing"
              ><input
                type="checkbox"
                :checked="!!route.query.ongoing"
                @change="filter({ ongoing: route.query.ongoing ? undefined : '1' })"
              />进行中</label
            >
            <label class="mobile-date"
              >服务日期<input
                type="date"
                :value="selectedDay"
                @change="filter({ date: inputValue($event) || undefined, unit: undefined })"
            /></label>
          </div>
        </div>
        <div class="result-heading">
          <h2>公开活动</h2>
          <span v-if="!busy && !error">共 {{ total }} 项</span>
          <button
            v-if="filtered"
            class="quiet compact reset"
            @click="
              scrollPosition = 0;
              router.push('/');
            "
          >
            清除筛选
          </button>
        </div>
        <p v-if="selectedDay" class="date-filter">
          <UiIcon name="Calendar" />{{
            unit !== 'day'
              ? windowLabel(range!.start, range!.end, unit)
              : selectedDay
          }}<button
            class="quiet"
            aria-label="清除服务日期"
            @click="filter({ date: undefined, unit: undefined })"
          >
            <UiIcon name="Close" />
          </button>
        </p>
        <p v-if="busy && !rows.length" class="notice" role="status">正在读取活动…</p>
        <p v-else-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
        <div v-else-if="!rows.length" class="empty-state">
          <UiIcon name="Search" />
          <p>暂无匹配的公开活动</p>
        </div>
        <ul v-else class="activity-list">
          <li v-for="{ row, firstDay } in cards" :key="row.id">
            <time
              class="date-tile"
              v-if="firstDay"
              :datetime="firstDay"
              :title="'活动开始日期 ' + firstDay"
            >
              <span>{{ Number(firstDay.slice(5, 7)) }} 月</span
              ><strong>{{ firstDay.slice(8) }}</strong>
            </time>
            <div class="activity-entry">
              <div class="activity-title">
                <RouterLink
                  :to="{ path: '/activities/' + row.id, query: listQuery }"
                  @click="rememberScroll"
                  >{{ row.title }}</RouterLink
                >
                <span
                  v-if="row.registration_phase"
                  class="state-chip"
                  :class="{ neutral: !row.is_ongoing && row.registration_phase !== 'open' }"
                  >{{ activityPrimaryStatus(row) }}</span
                >
              </div>
              <p class="entry-description" v-if="row.description">{{ row.description }}</p>
              <div class="meta-line">
                <span v-if="row.location || row.campus"
                  ><UiIcon name="Location" />{{
                    [row.campus, row.location].filter(Boolean).join(' · ')
                  }}</span
                >
                <span><UiIcon name="Calendar" />{{ serviceDateText(row.schedule) }}</span>
              </div>
              <div class="entry-foot">
                <span>名额 {{ row.capacity }} 人</span>
              </div>
            </div>
            <UiIcon name="ArrowRight" class="entry-arrow" />
          </li>
        </ul>
        <Pager
          v-if="!busy && !error && total > pageSize"
          :page="page"
          :size="pageSize"
          :total="total"
          @change="
            (p) => {
              scrollPosition = 0;
              router.push({ query: { ...listQuery, page: p } });
            }
          "
        />
      </section>
      <ServiceCalendar
        class="desktop-calendar"
        :selected="selectedDay"
        @select="(date) => filter({ date: date || undefined, unit: undefined })"
      />
    </div>
  </template>
</template>
<style scoped>
.discover-heading {
  border-bottom: 1px solid var(--line);
  padding-bottom: 20px;
}
.discovery {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 254px;
  align-items: start;
  gap: clamp(22px, 3vw, 48px);
}
.filters {
  padding: 16px;
  border-radius: var(--radius);
  background: var(--surface);
}
.search-form {
  display: flex;
  gap: 8px;
}
.search-field {
  flex: 1;
}
.search-form button {
  padding-inline: 20px;
}
.filter-row {
  --select-width: 7rem;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 18px;
  margin-top: 14px;
}
.filter-row label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--muted);
}
.filter-row .ongoing {
  gap: 0;
}
.campus-filter {
  width: 94px;
}
@media (max-width: 700px) {
  .campus-filter {
    width: 100%;
  }
}
.filter-row .mobile-date,
.mobile-filter {
  display: none;
}
.result-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 26px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.result-heading h2 {
  margin: 0;
  font-size: 18px;
}
.result-heading span,
.entry-foot {
  color: var(--muted);
  font-size: 13px;
}
.reset {
  margin-left: auto;
}
.date-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--yellow-tint);
  padding-left: 8px;
  border-radius: 4px;
  font-size: 13px;
}
.date-filter button {
  min-height: 28px;
  width: 28px;
  padding: 0;
}
.date-filter .ui-icon {
  width: 14px;
  height: 14px;
}
.activity-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.activity-list li {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding: 20px 4px;
  border-bottom: 1px solid var(--line);
}
.activity-list li:hover {
  background: #fafcff;
}
.activity-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.activity-title a {
  color: var(--ink);
  font-size: 18px;
  font-weight: 650;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.activity-title a:hover {
  color: var(--brand);
}
.activity-title a::after {
  content: '';
  position: absolute;
  inset: 0;
}
.date-tile {
  width: 56px;
  flex: none;
  text-align: center;
  border: 1px solid #d5e1f4;
  border-radius: 6px;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
}
.date-tile span {
  display: block;
  background: var(--brand-tint);
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
  padding: 2px;
}
.date-tile strong {
  display: block;
  font-size: 25px;
  font-weight: 620;
  line-height: 1.35;
}
.activity-entry {
  min-width: 0;
  flex: 1;
}
.entry-description {
  margin: 5px 0 9px;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.meta-line {
  margin-block: 8px;
}
.entry-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.entry-arrow {
  align-self: center;
  color: var(--brand);
  width: 15px;
  height: 15px;
}
@media (max-width: 1119px), (pointer: coarse) {
  .discovery {
    display: block;
  }
  .desktop-calendar {
    display: none;
  }
  .filter-row .mobile-date {
    display: inline-flex;
  }
}
@media (max-width: 700px) {
  .discover-heading {
    margin-bottom: 14px;
    padding-bottom: 14px;
  }
  .filters {
    padding: 12px;
  }
  .mobile-filter {
    display: inline-flex;
    margin-top: 3px;
    min-height: 44px;
    padding-inline: 0;
  }
  .mobile-filter .ui-icon:last-child {
    width: 12px;
  }
  .filter-row {
    display: none;
  }
  .filter-row.opened {
    --select-width: 100%;
    margin-top: 3px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }
  .filter-row label:not(.ongoing) {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }
  .filter-row .ongoing {
    order: 1;
    padding-top: 19px;
    min-height: 44px;
  }
  .result-heading {
    margin-top: 20px;
  }
  .activity-list li {
    gap: 10px;
    padding: 16px 0;
  }
  .date-tile {
    width: 44px;
  }
  .date-tile strong {
    font-size: 22px;
  }
  .activity-title a {
    font-size: 17px;
  }
  .entry-arrow {
    display: none;
  }
}
</style>
