<script setup lang="ts">
import AccountGate from '@hongyan/ui/AccountGate.vue';
</script>
<template>
 <header><strong>鸿雁志愿服务平台</strong></header>
 <main><AccountGate v-slot="{profile}">
  <nav aria-label="学生导航"><RouterLink to="/">活动</RouterLink><RouterLink to="/registrations">我的报名</RouterLink><RouterLink to="/notices">通知</RouterLink><RouterLink to="/mine">我的</RouterLink></nav>
  <p v-if="$route.meta.organizer && !profile.roles.includes('organizer')" role="alert">当前账号无活动管理权限。</p>
  <RouterView v-else v-slot="{Component}"><component :is="Component" v-bind="$route.meta.profile ? { profile } : {}" /></RouterView>
 </AccountGate></main>
</template>
<style scoped>
header{padding:16px 24px;color:var(--brand);border-bottom:1px solid var(--line)}main{max-width:960px;margin:auto;padding:16px 24px 76px}nav{display:flex;gap:16px;background:white;margin-bottom:24px}nav a{padding:8px;text-decoration:none}nav a[aria-current]{font-weight:700;border-bottom:2px solid var(--brand)}
@media(max-width:600px){nav{position:fixed;bottom:0;left:0;right:0;justify-content:space-around;gap:0;margin:0;padding-bottom:env(safe-area-inset-bottom);z-index:3;border-top:1px solid var(--line)}}
</style>
