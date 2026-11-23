<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { getManagedActivity, getActivityMembers, type Activity, type ActivityMemberList } from '@hongyan/contracts';
import RecordTable from '@hongyan/ui/RecordTable.vue';
import type { PreviewRecord } from '@hongyan/ui/preview';
import OwnerRepair from './OwnerRepair.vue';

const props = defineProps<{ id: string }>();
const activity = ref<Activity>(), team = ref<ActivityMemberList>(), error = ref(''), notice = ref('');
const owner = computed(() => team.value?.items.find(m => m.member_role === 'owner'));
const members = computed<PreviewRecord[]>(() => (team.value?.items ?? []).map(person => ({
  id: person.account_id, title: person.display_name,
  status: person.member_role === 'owner' ? '主负责人' : '协作者',
  fields: [['学号', person.student_no ?? '—']],
})));
const reasons = { account_disabled: '账号已停用', role_missing: '当前没有负责人角色', role_expired: '负责人角色已到期' };
let serial = 0;
async function load() {
  const turn = ++serial, path = { id: props.id };
  team.value = undefined;
  activity.value = undefined;
  error.value = '';
  try {
    const [details, members] = await Promise.all([
      getManagedActivity({ path, throwOnError: true }), getActivityMembers({ path, throwOnError: true }),
    ]);
    if (turn !== serial) return;
    activity.value = details.data.data.activity;
    team.value = members.data.data;
  } catch (e) { if (turn === serial) error.value = e instanceof Error ? e.message : '无法读取活动团队'; }
}
function saved(id: string, next: ActivityMemberList, message: string) {
  if (id !== props.id) return;
  team.value = next;
  notice.value = message;
}
function refresh(message: string) { notice.value = message; void load(); }
watch(() => props.id, () => refresh(''), { immediate: true });
onUnmounted(() => { serial++; });
</script>

<template>
  <RouterLink class="back-link" to="/manage/teams">返回活动团队</RouterLink>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
  <section v-else-if="activity && team && owner" class="team">
    <h1>{{ activity.title }}</h1>
    <p>{{ activity.activity_code }}</p>
    <header class="owner">
      <h2>当前主负责人：{{ owner.display_name }}</h2>
      <span v-if="team.owner_unavailable_reason" class="state-chip attention">{{ reasons[team.owner_unavailable_reason] }}</span>
    </header>
    <p v-if="team.owner_unavailable_reason">现任主负责人无法办理交接，请核对接任人后重新指定。</p>
    <h2>活动成员</h2>
    <RecordTable :records="members" label="活动成员" heading="姓名" status-heading="活动角色" />
    <OwnerRepair v-if="team.owner_unavailable_reason" :key="activity.id" :activity="activity" :team="team"
      @saved="saved" @refresh="refresh" />
  </section>
  <p v-else role="status">正在读取活动团队…</p>
</template>

<style scoped>
.team { max-width:48rem; }
.owner { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
h2 { font-size:1.15rem; }
</style>
