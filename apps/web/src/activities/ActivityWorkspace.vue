<script setup lang="ts">
import ActivityMemberListView from './ActivityMemberListView.vue';
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
    // 退出与恢复目前是本地示例，切换列表、记录或筛选时没有业务请求可复核权限。
    if (route.name === 'organizer-section' && activity.value?.id === route.params.id) void refresh();
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
const team = ref<ActivityMemberList>({ items: [], version: 0 });
const members = computed(() => team.value.items);
function applyTeam(id: string, next: ActivityMemberList) {
  if (id === route.params.id && next.version >= team.value.version) team.value = next;
}
const error = ref('');
const access = ref<'unknown' | 'member' | 'lost' | 'unavailable'>('unknown');
const inaccessible = computed(() => access.value === 'lost' || access.value === 'unavailable');
const backSchedule = computed(() => !inaccessible.value && scheduleReturn);
const verifying = ref(false);
const sourceQuery = computed(() => ({ page: route.query.page }));
const self = computed(() => members.value.find((m) => m.account_id === props.profile.account_id));
const transferTarget = ref('');
const transferMessage = computed(() => {
  if (!transferTarget.value || self.value?.member_role !== 'collaborator') return '';
  const owner = members.value.find(member => member.member_role === 'owner');
  if (!owner) return '';
  return owner.account_id === transferTarget.value ? '主负责人已交接给' + owner.display_name + '。'
    : '已核对活动成员，当前主负责人是' + owner.display_name + '。';
});
let generation = 0;
function denyAccess() {
  access.value = access.value === 'member' || access.value === 'lost' ? 'lost' : 'unavailable';
  detail.value = undefined;
  team.value = { items: [], version: 0 };
  transferTarget.value = '';
}
async function load(clear = true) {
  const turn = ++generation;
  verifying.value = true;
  if (clear) {
    access.value = 'unknown';
    transferTarget.value = '';
    detail.value = undefined;
    team.value = { items: [], version: 0 };
  }
  error.value = '';
  try {
    const path = { id: String(route.params.id) };
    const next = (await getActivityMembers({ path, throwOnError: true })).data.data;
    if (turn !== generation) return false;
    if (!next.items.some((m) => m.account_id === props.profile.account_id)) {
      denyAccess();
      return false;
    }
    const latest = (await getManagedActivity({ path, throwOnError: true })).data.data;
    if (turn !== generation) return false;
    showDetail(latest);
    applyTeam(path.id, next);
    access.value = 'member';
    return true;
  } catch (e) {
    if (turn === generation) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        denyAccess();
      } else {
        if (e instanceof ApiError && e.status === 401) {
          detail.value = undefined;
          team.value = { items: [], version: 0 };
        }
        error.value = e instanceof Error ? e.message : '活动读取失败';
      }
    }
    return false;
  } finally {
    if (turn === generation) verifying.value = false;
  }
}
const refresh = () => load(false);
watch([() => route.params.id, () => props.profile.account_id], () => load(), { immediate: true });
onMounted(() => window.addEventListener('focus', refresh));
onUnmounted(() => {
  generation++;
  window.removeEventListener('focus', refresh);
});
</script>
<template>
  <RouterLink class="back-link" :to="backSchedule || { path: '/managed', query: sourceQuery }"
    ><UiIcon name="ArrowLeft" />{{ backSchedule ? '返回日程' : '返回我的管理活动' }}</RouterLink
  >
  <p v-if="error" role="alert">{{ error }} <button @click="refresh">重试</button></p>
  <p v-else-if="inaccessible" class="notice" role="alert">{{ access === 'lost'
    ? '你已不在本活动团队，个人功能不受影响。' : '当前账号无法访问此活动。' }}</p>
  <p v-else-if="!self" role="status">正在核验活动成员…</p>
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
        v-on="route.name === 'organizer-section' ? {} : { denied: refresh }"
        v-bind="
          route.name === 'organizer-section' ? { verifyAccess: refresh } :
          ['activity-notices', 'activity-hour-incidents'].includes(String(route.name))
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
      <p v-if="transferMessage" class="notice" role="status">{{ transferMessage }}</p>
      <ActivityMemberListView :key="activity.id + self.member_role" :activity="activity" :team="team"
        :can-manage="self.member_role === 'owner'" :paused="verifying || !!error" @saved="applyTeam" @refresh="refresh" />
      <AddCollaborator v-if="self.member_role === 'owner'" :key="activity.id" :activity="activity"
        :team="team" :paused="verifying || !!error" @saved="applyTeam" @refresh="refresh" />
      <TransferOwner v-if="self.member_role === 'owner'" :key="activity.id + team.version" :activity="activity"
        :team="team" :paused="verifying || !!error" @target="transferTarget = $event" @saved="applyTeam" @refresh="refresh" />
      <p v-else>你是本活动的协作者。成员变更由主负责人或授权后台办理。</p>
    </section>
  </template>
</template>

<style scoped>
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
