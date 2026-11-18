<script setup lang="ts">
import type { Profile } from '@hongyan/contracts';
defineProps<{profile:Profile}>();
import { sections, sectionKeys } from '../management/sections';
import VbenLayout from './vben/VbenLayout.vue';
</script>

<template>
  <VbenLayout>
    <template #logo><strong>鸿雁志愿服务平台</strong></template>
    <template #menu><RouterLink to="/">待办</RouterLink><RouterLink to="/reviews">活动审核</RouterLink><RouterLink to="/hours">时长审核</RouterLink><RouterLink v-for="key in sectionKeys" :key="key" :to="'/manage/' + key">{{ sections[key].title }}</RouterLink><RouterLink :to="{ name: 'connection' }">连接状态</RouterLink></template>
    <template #header>审核后台</template>
    <template #content>
      <h1 v-if="$route.name==='connection'">服务连接</h1>
      <RouterView v-bind="$route.meta.profile ? { profile } : {}" />
    </template>
  </VbenLayout>
</template>

<style scoped>
strong { color: var(--brand); }
a { display: block; padding: 10px 12px; border-radius: 6px; text-decoration: none; }
a[aria-current='page'] { background: #e4ebf8; color: var(--brand); font-weight: 600; }
</style>
