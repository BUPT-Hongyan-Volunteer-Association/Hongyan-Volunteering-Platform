<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { Profile } from '@hongyan/contracts';
import BrandName from '@hongyan/ui/BrandName.vue';
import UiIcon, { type IconName } from '@hongyan/ui/UiIcon.vue';
import AccountIdentity from '@hongyan/ui/AccountIdentity.vue';
import { navigation, groups } from '../navigation';
import VbenLayout from './vben/VbenLayout.vue';

defineProps<{ profile: Profile; busy: boolean }>();
defineEmits<{ logout: [] }>();
const route = useRoute();
const entry = computed(() => navigation[route.meta.section as keyof typeof navigation]);
const crumb = computed(() => route.meta.title ?? entry.value?.label);
const current = (to: string) => entry.value?.to === to;
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
