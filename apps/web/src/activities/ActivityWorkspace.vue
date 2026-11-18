<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  ApiError,
  getActivityMembers,
  getManagedActivity,
  type ActivityMember,
  type Profile,
} from '@hongyan/contracts';

const props = defineProps<{ profile: Profile }>();
const route = useRoute();
const base = computed(() => '/managed/' + route.params.id);
const title = ref('');
const activityCode = ref('');
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
    const detail = (await getManagedActivity({ path, throwOnError: true })).data.data;
    if (turn !== generation) return;
    title.value = detail.activity.title;
    activityCode.value = detail.activity.activity_code;
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
  <RouterLink :to="{ path: '/managed', query: sourceQuery }">返回我的管理活动</RouterLink>
  <p v-if="error" role="alert">{{ error }} <button @click="refresh">重试</button></p>
  <p v-if="!self && !error" role="status">正在核验活动成员…</p>
  <template v-if="self">
    <header class="section-heading">
      <h1>{{ title }}</h1>
      <span>{{ self.member_role === 'owner' ? '主负责人' : '协作者' }}</span>
    </header>
    <nav class="section-nav" aria-label="活动工作区">
      <RouterLink :to="{ path: base, query: sourceQuery }">活动概览</RouterLink>
      <RouterLink :to="{ path: base + '/edit', query: sourceQuery }">编辑与送审</RouterLink>
      <RouterLink :to="{ path: base + '/roster', query: sourceQuery }">报名名单</RouterLink>
      <RouterLink
        v-for="[path, label] in sections"
        :key="path"
        :class="{ current: route.params.area === path }"
        :to="{ path: base + '/' + path, query: sourceQuery }"
        >{{ label }}</RouterLink
      >
    </nav>
    <RouterView v-if="route.name !== 'managed-overview'" v-slot="{ Component }">
      <component
        :is="Component"
        v-bind="
          route.name === 'organizer-section'
            ? { activityCode }
            : route.name === 'activity-edit'
              ? { writesPaused: verifying || !!error }
              : {}
        "
        :key="base"
      />
    </RouterView>
    <section v-else>
      <h2>活动成员</h2>
      <ul>
        <li v-for="m in members" :key="m.account_id">
          {{ m.display_name }} · {{ m.member_role === 'owner' ? '主负责人' : '协作者' }}
        </li>
      </ul>
      <details v-if="self.member_role === 'owner'">
        <summary>管理成员（预览）</summary>
        <form
          class="preview-form"
          @submit.prevent="memberMessage = '示例操作尚待接入，活动成员未变更。'"
        >
          <label
            >操作<select>
              <option>添加协作者</option>
              <option v-if="members.length > 1">移除协作者</option>
              <option v-if="members.length > 1">转移主负责人</option>
            </select></label
          >
          <label>成员学号<input required pattern="[0-9]{10}" maxlength="10" /></label
          ><label>原因<input required /></label><button>预览成员变更</button>
        </form>
        <p v-if="memberMessage" role="status">{{ memberMessage }}</p>
      </details>
    </section>
  </template>
</template>
