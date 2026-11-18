<script setup lang="ts">
import UiIcon from './UiIcon.vue';
defineProps<{ name: string; busy: boolean }>();
defineEmits<{ logout: [] }>();
</script>
<template>
  <div class="identity">
    <span class="identity-name"><UiIcon name="User" />{{ name }}</span>
    <button
      class="icon-button logout"
      type="button"
      title="退出登录"
      aria-label="退出登录"
      :disabled="busy"
      @click="$emit('logout')"
    >
      <UiIcon name="SwitchButton" />
    </button>
  </div>
</template>
