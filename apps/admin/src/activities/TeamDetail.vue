<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { getManagedActivity, getActivityMembers, type ActivityMemberList } from '@hongyan/contracts';
import { usePageRead } from '@hongyan/ui/usePageRead';
import ActivityMemberListView from '@hongyan/ui/ActivityMemberListView.vue';
import OwnerRepair from './OwnerRepair.vue';

const props = defineProps<{ id: string }>();
const notice = ref('');
const { data, error, refresh: load } = usePageRead(() => props.id, async signal => {
  const path = { id: props.id };
  const [details, members] = await Promise.all([
    getManagedActivity({ path, signal, throwOnError: true }),
    getActivityMembers({ path, signal, throwOnError: true }),
  ]);
  return { activity: details.data.data.activity, team: members.data.data };
});
const activity = computed(() => data.value?.activity);
const team = computed(() => data.value?.team);
const owner = computed(() => team.value?.items.find(member => member.member_role === 'owner'));
const reasons = { account_disabled: '账号已停用', credential_pending: '登录凭证待发放', role_missing: '当前没有负责人角色', role_expired: '负责人角色已到期' };

function saved(id: string, next: ActivityMemberList, message = '') {
  if (data.value?.activity.id !== id || next.version < data.value.team.version) return;
  data.value = { ...data.value, team: next };
  notice.value = message;
}
function refresh(message = '') { notice.value = message; void load(); }
watch(() => props.id, () => { notice.value = ''; });
</script>

<template>
  <RouterLink class="back-link" :to="{ path: '/manage/teams', query: $route.query }">返回活动团队</RouterLink>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
  <section v-else-if="activity && team && owner" class="team">
    <h1>{{ activity.title }}</h1>
    <p>{{ activity.activity_code }}</p>
    <header class="owner">
      <h2>当前主负责人：{{ owner.display_name }}</h2>
      <span v-if="team.owner_unavailable_reason" class="state-chip attention">{{ reasons[team.owner_unavailable_reason] }}</span>
    </header>
    <p v-if="team.owner_unavailable_reason">现任主负责人无法办理交接，请核对接任人后重新指定。</p>
    <h2>活动成员</h2>
    <ActivityMemberListView :activity="activity" :team="team" can-manage :paused="false" @saved="saved" @refresh="refresh" />
    <OwnerRepair :key="activity.id" :activity="activity" :team="team"
      @saved="saved" @refresh="refresh" />
  </section>
  <p v-else role="status">正在读取活动团队…</p>
</template>

<style scoped>
.team { max-width:48rem; }
.owner { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
h2 { font-size:1.15rem; }
</style>
