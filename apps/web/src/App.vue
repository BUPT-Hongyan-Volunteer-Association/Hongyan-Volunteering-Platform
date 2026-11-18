<script setup lang="ts">
import SessionStatus from '@hongyan/ui/SessionStatus.vue';
</script>

<template>
  <header><strong>鸿雁志愿服务平台</strong></header>
  <main>
    <h1>学生与负责人入口</h1>
    <SessionStatus />
  </main>
</template>

<style scoped>
header { border-bottom: 1px solid var(--line); padding: 16px max(24px, calc((100vw - 960px) / 2));
  color: var(--brand); font-size: 18px; }
main { max-width: 1008px; margin: 0 auto; padding: clamp(32px, 5vw, 64px) 24px; }
</style>
