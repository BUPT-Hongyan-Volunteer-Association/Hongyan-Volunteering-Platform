<script setup lang="ts">
import AccountGate from '@hongyan/ui/AccountGate.vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>
<template>
  <ElConfigProvider :locale="zhCn">
    <AccountGate admin v-slot="{ profile, busy, logout }"
      ><RouterView :profile="profile" :busy="busy" @logout="logout"
    /></AccountGate>
  </ElConfigProvider>
</template>
