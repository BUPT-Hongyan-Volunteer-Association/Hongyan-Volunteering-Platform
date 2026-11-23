<script setup lang="ts">
import TransferOwner from './TransferOwner.vue';
import AddCollaborator from './AddCollaborator.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { serviceTime } from '@hongyan/ui/activityDisplay';
import { useRoute } from 'vue-router';
import {
  ApiError,
  getActivityMembers,
  getManagedActivity,
  type ManagedActivityDetail,
  type ActivityMemberList,
  type Profile,
} from '@hongyan/contracts';

const props = defineProps<{ profile: Profile }>();
const route = useRoute();
const origin = window.history.state?.scheduleReturn;
const scheduleReturn =
  typeof origin === 'string' && /^\/managed-schedule(?:\?|$)/.test(origin) ? origin : undefined;
const base = computed(() => '/managed/' + route.params.id);
const detail = ref<ManagedActivityDetail>();
const activity = computed(() => detail.value?.activity);
function showDetail(next: ManagedActivityDetail) {
  if (
    next.activity.id === route.params.id &&
    next.activity.version >= (activity.value?.version ?? 0)
  )
    detail.value = next;
}
const more = ref<HTMLDetailsElement>();
watch(
  () => route.fullPath,
  () => {
    if (more.value) more.value.open = false;
  },
);
const sections = [
  ['notices', '通知与回执'],
  ['attendance', '现场人员记录'],
  ['batches', '时长批次'],
  ['hours', '时长台账'],
  ['appeals', '漏记反馈'],
  ['corrections', '错账修复组'],
  ['incidents', '异常记录'],
  ['requests', '退出与恢复'],
];
const deniedRefresh = ['activity-attendance', 'hour-batches', 'hour-batch', 'activity-hours',
  'activity-hour-appeals', 'activity-hour-corrections', 'activity-hour-incidents'];
const team = ref<ActivityMemberList>({ items: [], version: 0 });
const members = computed(() => team.value.items);
function applyTeam(id: string, next: ActivityMemberList) {
  if (id === route.params.id && next.version >= team.value.version) team.value = next;
}
const error = ref('');
const verifying = ref(false);
const sourceQuery = computed(() => ({ page: route.query.page }));
const self = computed(() => members.value.find((m) => m.account_id === props.profile.account_id));
let generation = 0;
async function load(clear = true) {
  const turn = ++generation;
  verifying.value = true;
  if (clear) {
    detail.value = undefined;
    team.value = { items: [], version: 0 };
  }
  error.value = '';
  try {
    const path = { id: String(route.params.id) };
    const next = (await getActivityMembers({ path, throwOnError: true })).data.data;
    if (!next.items.some((m) => m.account_id === props.profile.account_id)) {
      if (turn !== generation) return;
      team.value = { items: [], version: 0 };
      error.value = '当前账号不是该活动的管理成员。';
      return;
    }
    const latest = (await getManagedActivity({ path, throwOnError: true })).data.data;
    if (turn !== generation) return;
    showDetail(latest);
    applyTeam(path.id, next);
  } catch (e) {
    if (turn !== generation) return;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0)) team.value = { items: [], version: 0 };
    error.value = e instanceof Error ? e.message : '活动读取失败';
  } finally {
    if (turn === generation) verifying.value = false;
  }
}
const refresh = () => void load(false);
watch([() => route.params.id, () => props.profile.account_id], () => load(), { immediate: true });
onMounted(() => window.addEventListener('focus', refresh));
onUnmounted(() => {
  generation++;
  window.removeEventListener('focus', refresh);
});
</script>
<template>
  <RouterLink class="back-link" :to="scheduleReturn || { path: '/managed', query: sourceQuery }"
    ><UiIcon name="ArrowLeft" />{{ scheduleReturn ? '返回日程' : '返回我的管理活动' }}</RouterLink
  >
  <p v-if="error" role="alert">{{ error }} <button @click="refresh">重试</button></p>
  <p v-if="!self && !error" role="status">正在核验活动成员…</p>
  <template v-if="self && activity">
    <header class="section-heading">
      <h1>{{ activity.title }}</h1>
      <span class="state-chip">{{ self.member_role === 'owner' ? '主负责人' : '协作者' }}</span>
      <div class="workspace-tools">
        <RouterLink class="button" :to="{ path: base, query: sourceQuery }"
          ><UiIcon name="List" />活动概览</RouterLink
        >
        <RouterLink class="button" :to="{ path: base + '/edit', query: sourceQuery }"
          ><UiIcon name="EditPen" />编辑与送审</RouterLink
        >
      </div>
    </header>
    <p class="activity-meta meta-line">
      <span>{{ activity.activity_code }}</span
      ><span v-if="activity.campus"><UiIcon name="Location" />{{ activity.campus }}</span
      ><span><UiIcon name="Clock" />{{ serviceTime(activity) }}</span>
    </p>
    <nav class="section-nav" aria-label="活动工作区">
      <RouterLink :to="{ path: base + '/roster', query: sourceQuery }">报名名单</RouterLink>
      <RouterLink
        v-for="[path, label] in sections.slice(0, 4)"
        :key="path"
        :class="{ current: (route.params.area ?? route.meta.area) === path }"
        :to="{ path: base + '/' + path, query: sourceQuery }"
        >{{ label }}</RouterLink
      >
      <details class="more" ref="more">
        <summary
          :class="{ current: sections.slice(4).some(([path]) => (route.params.area ?? route.meta.area) === path) }"
        >
          更多
        </summary>
        <div class="more-menu">
          <RouterLink
            v-for="[path, label] in sections.slice(4)"
            :key="path"
            :to="{ path: base + '/' + path, query: sourceQuery }"
            >{{ label }}</RouterLink
          >
        </div>
      </details>
    </nav>
    <RouterView v-if="route.name !== 'managed-overview'" v-slot="{ Component }">
      <component
        :is="Component"
        v-on="deniedRefresh.includes(String(route.name)) ? { denied: refresh } : {}"
        v-bind="
          ['organizer-section', 'activity-notices', 'activity-hour-incidents'].includes(String(route.name))
            ? {}
            : route.name === 'activity-edit'
              ? { writesPaused: verifying || !!error, snapshot: detail, onLoaded: showDetail }
              : { writesPaused: verifying || !!error,
                  ...(route.name === 'activity-hour-corrections' && { accountId: profile.account_id }) }
        "
        :key="route.name === 'hour-batch' ? base + '/' + route.params.item : base"
      />
    </RouterView>
    <section v-else class="reading-area">
      <h2>活动成员</h2>
      <ul class="member-list">
        <li v-for="m in members" :key="m.account_id">
          <span class="item-icon"><UiIcon name="User" /></span><strong>{{ m.display_name }}</strong
          ><span class="state-chip neutral">{{
            m.member_role === 'owner' ? '主负责人' : '协作者'
          }}</span>
        </li>
      </ul>
      <AddCollaborator v-if="self.member_role === 'owner'" :key="activity.id" :activity="activity"
        :team="team" :paused="verifying || !!error" @saved="applyTeam" @refresh="refresh" />
      <TransferOwner v-if="self.member_role === 'owner'" :key="activity.id + team.version" :activity="activity"
        :team="team" :paused="verifying || !!error" @saved="applyTeam" @refresh="refresh" />
      <p v-else>你是本活动的协作者。成员变更由主负责人或授权后台办理。</p>
    </section>
  </template>
</template>

<style scoped>
.member-list {
  display: grid;
  list-style: none;
  padding: 0;
  border-top: 1px solid var(--line);
}
.member-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
@media (max-width: 700px) {
  .workspace-tools {
    width: 100%;
  }
}
.activity-meta {
  color: var(--muted);
  font-size: 14px;
  margin: 0 0 16px;
}
.workspace-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.workspace-tools a {
  font-size: 14px;
  padding: 5px 12px;
  border: 1px solid #cad5e5;
  border-radius: 6px;
  text-decoration: none;
}
.more {
  position: relative;
  margin-left: auto;
}
.more summary {
  padding: 10px;
  cursor: pointer;
  color: var(--brand);
  min-height: 44px;
}
.more-menu {
  position: absolute;
  right: 0;
  z-index: 4;
  min-width: 140px;
  border: 1px solid var(--line);
  background: white;
  border-radius: 6px;
  padding: 4px 12px;
  box-shadow: 0 6px 18px #17243a14;
}
.section-nav {
  margin-bottom: 16px;
}
.more-menu a {
  color: var(--ink);
}
.more summary.current {
  box-shadow: inset 0 -2px var(--brand);
  font-weight: 650;
}
</style>
