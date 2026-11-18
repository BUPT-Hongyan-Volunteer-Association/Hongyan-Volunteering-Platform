<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { Profile } from '@hongyan/contracts';
import BrandName from '@hongyan/ui/BrandName.vue';
import UiIcon, { type IconName } from '@hongyan/ui/UiIcon.vue';
import AccountIdentity from '@hongyan/ui/AccountIdentity.vue';
import { sections, type SectionKey } from '../management/sections';
import VbenLayout from './vben/VbenLayout.vue';

defineProps<{ profile: Profile; busy: boolean }>();
defineEmits<{ logout: [] }>();
const route = useRoute();
const managementIcons: Record<SectionKey, IconName> = {
  corrections: 'CopyDocument',
  incidents: 'Warning',
  appeals: 'ChatLineSquare',
  students: 'User',
  imports: 'Upload',
  accounts: 'Key',
  failures: 'Message',
  audit: 'Notebook',
};
const groups = [
  [
    { to: '/', label: '待办', icon: 'List' },
    { to: '/schedule', label: '全院日程', icon: 'Calendar' },
  ],
  [
    { to: '/reviews', label: '活动审核', icon: 'DocumentChecked' },
    { to: '/hours', label: '时长审核', icon: 'Clock' },
    ...managementLinks(['corrections', 'incidents', 'appeals']),
  ],
  managementLinks(['students', 'imports', 'accounts']),
  [
    ...managementLinks(['failures', 'audit']),
    { to: '/connection', label: '连接状态', icon: 'Connection' },
  ],
] as const;
function managementLinks(keys: SectionKey[]) {
  return keys.map((key) => ({
    to: '/manage/' + key,
    label: sections[key].title,
    icon: managementIcons[key],
  }));
}
const current = (to: string) =>
  route.path === to || (to !== '/' && route.path.startsWith(to + '/'));
const crumb = computed(() =>
  route.path.startsWith('/hours/')
    ? '批次审核'
    : groups.flat().find((item) => current(item.to))?.label,
);
</script>
<template>
  <VbenLayout>
    <template #logo><BrandName area="审核后台" /></template>
    <template #menu>
      <div class="nav-group" v-for="group in groups" :key="group[0].to">
        <RouterLink
          v-for="item in group"
          :key="item.to"
          :to="item.to"
          :class="{ current: current(item.to) }"
          :aria-current="current(item.to) ? 'page' : undefined"
          ><UiIcon :name="item.icon as IconName" />{{ item.label }}</RouterLink
        >
      </div>
    </template>
    <template #header>
      <div class="crumbs">
        <span>审核后台</span><UiIcon name="ArrowRight" /><strong>{{ crumb }}</strong>
      </div>
      <AccountIdentity :name="profile.display_name" :busy="busy" @logout="$emit('logout')" />
    </template>
    <template #content>
      <h1 v-if="$route.name === 'connection'">服务连接</h1>
      <RouterView v-bind="$route.meta.profile ? { profile } : {}" />
    </template>
  </VbenLayout>
</template>
<style scoped>
.nav-group {
  display: grid;
  gap: 2px;
}
.nav-group + .nav-group {
  padding-top: 10px;
  margin-top: 8px;
  border-top: 1px solid var(--line);
}
@media (max-width: 700px) {
  .nav-group {
    display: contents;
  }
}
</style>
