<!-- Vue Vben Admin v5.7.0, layout-ui 的 sidebar-nav 布局。上游许可见 LICENSE。 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
const media = window.matchMedia('(max-width: 700px)');
const collapsed = ref(media.matches);
const resize = () => {
  collapsed.value = media.matches;
};
onMounted(() => media.addEventListener('change', resize));
onUnmounted(() => media.removeEventListener('change', resize));
</script>
<template>
  <div class="app-shell admin-shell" :class="{ 'no-rail': collapsed }">
    <aside v-show="!collapsed" id="vben-sidebar" class="app-rail admin-rail">
      <slot name="logo" />
      <nav class="rail-nav" aria-label="后台导航"><slot name="menu" /></nav>
    </aside>
    <div class="workspace">
      <header class="shell-top">
        <button
          class="icon-button quiet"
          type="button"
          aria-controls="vben-sidebar"
          :aria-expanded="!collapsed"
          :title="collapsed ? '展开导航' : '收起导航'"
          :aria-label="collapsed ? '展开导航' : '收起导航'"
          @click="collapsed = !collapsed"
        >
          <UiIcon :name="collapsed ? 'Expand' : 'Fold'" />
        </button>
        <slot name="header" />
      </header>
      <main class="shell-content" id="__vben_main_content"><slot name="content" /></main>
    </div>
  </div>
</template>
<style scoped>
.admin-rail {
  padding-top: 24px;
}
.admin-rail :deep(.brand) {
  margin-bottom: 22px;
}
.admin-rail :deep(.rail-nav) {
  gap: 2px;
}
.admin-rail :deep(.rail-nav a) {
  min-height: 38px;
  padding-block: 7px;
}
@media (max-width: 700px) {
  .admin-shell {
    display: flex;
    flex-direction: column;
  }
  .workspace {
    display: contents;
  }
  .shell-top {
    order: 0;
  }
  .shell-content {
    order: 2;
    width: 100%;
    padding-bottom: 32px;
  }
  .admin-rail {
    order: 1;
    position: static;
    height: auto;
    border: 0;
    border-bottom: 1px solid var(--line);
    padding: 12px 16px;
  }
  .admin-rail :deep(.brand) {
    display: none;
  }
  .admin-rail :deep(.rail-nav) {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 3px;
  }
  .admin-rail :deep(.rail-nav a) {
    padding: 4px;
    min-height: 44px;
    gap: 5px;
    font-size: 13px;
  }
}
</style>
