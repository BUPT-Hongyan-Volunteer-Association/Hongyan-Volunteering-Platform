<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { serviceTime } from '@hongyan/ui/activityDisplay';
import { useRoute } from 'vue-router';
import {
  ApiError,
  getActivityMembers,
  getManagedActivity,
  type ManagedActivityDetail,
  type ActivityMember,
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
const memberMessage = ref('');
const sections = [
  ['requests', '退出与恢复'],
  ['notices', '通知与回执'],
  ['attendance', '现场人员记录'],
  ['batches', '时长批次'],
  ['appeals', '漏记反馈'],
  ['corrections', '错账修复组'],
  ['incidents', '异常上报'],
];
const members = ref<ActivityMember[]>([]);
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
    members.value = [];
    memberMessage.value = '';
  }
  error.value = '';
  try {
    const path = { id: String(route.params.id) };
    const team = (await getActivityMembers({ path, throwOnError: true })).data.data.items;
    if (!team.some((m) => m.account_id === props.profile.account_id)) {
      if (turn !== generation) return;
      members.value = [];
      error.value = '当前账号不是该活动的管理成员。';
      return;
    }
    const latest = (await getManagedActivity({ path, throwOnError: true })).data.data;
    if (turn !== generation) return;
    showDetail(latest);
    members.value = team;
  } catch (e) {
    if (turn !== generation) return;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0)) members.value = [];
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
          :class="{ current: sections.slice(4).some(([path]) => route.params.area === path) }"
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
        v-on="['activity-attendance', 'hour-batches', 'hour-batch'].includes(String(route.name)) ? { denied: refresh } : {}"
        v-bind="
          ['organizer-section', 'activity-notices'].includes(String(route.name))
            ? {}
            : route.name === 'activity-edit'
              ? { writesPaused: verifying || !!error, snapshot: detail, onLoaded: showDetail }
              : { writesPaused: verifying || !!error }
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
      <details v-if="self.member_role === 'owner'">
        <summary>管理成员（预览）</summary>
        <form
          class="preview-form"
          @submit.prevent="memberMessage = '示例操作尚待接入，活动成员未变更。'"
        >
          <label
            >操作<UiSelect
              label="操作"
              :options="
                members.length > 1 ? ['添加协作者', '移除协作者', '转移主负责人'] : ['添加协作者']
              "
          /></label>
          <label>成员学号<input required pattern="[0-9]{10}" maxlength="10" /></label
          ><label>原因<input required /></label><button>预览成员变更</button>
        </form>
        <p v-if="memberMessage" role="status">{{ memberMessage }}</p>
      </details>
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
