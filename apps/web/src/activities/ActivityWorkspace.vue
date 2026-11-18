<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getActivityMembers, getManagedActivity, type ActivityMember, type Profile } from '@hongyan/contracts';

const props = defineProps<{ profile: Profile }>();
const route = useRoute();
const base = computed(() => '/managed/' + route.params.id);
const title = ref('');
const members = ref<ActivityMember[]>([]);
const error = ref('');
const self = computed(() => members.value.find(m => m.account_id === props.profile.account_id));
let generation = 0;
async function load(clear = true) {
  const turn = ++generation;
  if (clear) members.value = [];
  error.value = '';
  try {
    const path = { id: String(route.params.id) };
    const team = (await getActivityMembers({ path, throwOnError: true })).data.data.items;
    if (!team.some(m => m.account_id === props.profile.account_id)) throw Error('当前账号不是该活动的管理成员。');
    const detail = (await getManagedActivity({ path, throwOnError: true })).data.data;
    if (turn !== generation) return;
    title.value = detail.activity.title;
    members.value = team;
  } catch (e) {
    if (turn !== generation) return;
    members.value = [];
    title.value = '';
    error.value = e instanceof Error ? e.message : '活动读取失败';
  }
}
const refresh = () => void load(false);
watch(() => [route.fullPath, props.profile.account_id], () => load(), { immediate: true });
onMounted(() => window.addEventListener('focus', refresh));
onUnmounted(() => { generation++; window.removeEventListener('focus', refresh); });
</script>
<template>
  <RouterLink to="/managed">返回我的管理活动</RouterLink>
  <p v-if="error" role="alert">{{ error }} <button @click="load()">重试</button></p>
  <p v-else-if="!self" role="status">正在核验活动成员…</p>
  <template v-else>
    <header class="section-heading"><h1>{{ title }}</h1><span>{{ self.member_role === 'owner' ? '主负责人' : '协作者' }}</span></header>
    <nav class="section-nav" aria-label="活动工作区">
      <RouterLink :to="base">活动概览</RouterLink>
      <RouterLink :to="base + '/edit'">编辑与送审</RouterLink>
      <RouterLink :to="base + '/roster'">报名名单</RouterLink>
    </nav>
    <RouterView v-if="route.name !== 'managed-overview'" v-slot="{ Component }">
      <component :is="Component" v-bind="route.name === 'roster' ? { profile } : {}" :key="base" />
    </RouterView>
    <section v-else><h2>活动成员</h2><ul><li v-for="m in members" :key="m.account_id">{{ m.display_name }} · {{ m.member_role === 'owner' ? '主负责人' : '协作者' }}</li></ul></section>
  </template>
</template>
