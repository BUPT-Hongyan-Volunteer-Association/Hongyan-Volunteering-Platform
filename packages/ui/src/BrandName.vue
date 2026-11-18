<script setup lang="ts">
defineProps<{ area?: string }>();
</script>
<template>
  <div class="brand">
    <strong class="brand-name"><b>鸿雁</b>志愿服务平台</strong>
    <span v-if="area" class="brand-area">{{ area }}</span>
  </div>
</template>
