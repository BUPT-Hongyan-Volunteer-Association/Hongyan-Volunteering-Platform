<script setup lang="ts">
import AccountGate from '@hongyan/ui/AccountGate.vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <AccountGate admin><RouterView /></AccountGate>
  </ElConfigProvider>
</template>
