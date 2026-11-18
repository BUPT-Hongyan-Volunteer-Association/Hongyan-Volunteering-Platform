<script setup lang="ts">
import type { Profile } from '@hongyan/contracts';
defineProps<{ profile: Profile }>();
</script>
<template>
  <template v-if="$route.path === '/mine'"
    ><h1>我的</h1>
    <RouterLink v-if="profile.roles.includes('organizer')" to="/managed"
      >活动管理</RouterLink
    ></template
  >
  <template v-else
    ><h1>{{ $route.path === '/notices' ? '通知' : '我的报名' }}</h1>
    <p>此功能待接入。</p></template
  >
</template>
