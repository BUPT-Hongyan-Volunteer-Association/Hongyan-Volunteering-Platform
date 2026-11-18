<script setup lang="ts">
import { ref } from 'vue';
import AccountGate from '@hongyan/ui/AccountGate.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
const manage=ref(false);
</script>
<template>
 <header><strong>鸿雁志愿服务平台</strong></header>
 <main><AccountGate v-slot="{profile}">
   <h1>我的</h1>
   <button v-if="profile.roles.includes('organizer')" @click="manage=!manage">活动管理</button>
   <ManagedActivities v-if="manage && profile.roles.includes('organizer')" />
 </AccountGate></main>
</template>
<style scoped>
header { padding:16px 24px; border-bottom:1px solid var(--line); color:var(--brand); }
main { max-width:960px; margin:auto; padding:24px; }
</style>
