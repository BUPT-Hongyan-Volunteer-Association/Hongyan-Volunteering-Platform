<!-- Vue Vben Admin v5.7.0, layout-ui 的 sidebar-nav 布局。上游许可见 LICENSE。 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const media = window.matchMedia('(max-width: 640px)');
const sidebarCollapse = ref(media.matches);
const updateViewport = (event: MediaQueryListEvent) => { sidebarCollapse.value = event.matches; };

onMounted(() => media.addEventListener('change', updateViewport));
onUnmounted(() => media.removeEventListener('change', updateViewport));
</script>

<template>
  <div class="layout" :class="{ collapsed: sidebarCollapse }">
    <aside v-show="!sidebarCollapse" id="vben-sidebar">
      <slot name="logo" />
      <nav aria-label="后台导航"><slot name="menu" /></nav>
    </aside>
    <div class="workspace">
      <header class="toolbar">
        <button type="button" aria-controls="vben-sidebar" :aria-expanded="!sidebarCollapse"
          @click="sidebarCollapse = !sidebarCollapse">{{ sidebarCollapse ? '展开导航' : '收起导航' }}</button>
        <slot name="header" />
      </header>
      <main id="__vben_main_content"><slot name="content" /></main>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }
.layout.collapsed { grid-template-columns: minmax(0, 1fr); }
aside { background: var(--surface); padding: 20px 16px; border-right: 1px solid var(--line); }
nav { margin-top: 40px; }
.toolbar { display: flex; align-items: center; gap: 16px; height: 64px; padding: 0 24px;
  border-bottom: 1px solid var(--line); color: var(--muted); }
button { background: white; border: 1px solid var(--line); border-radius: 6px;
  padding: 6px 10px; color: var(--brand); font: inherit; cursor: pointer; }
main { max-width: 1056px; padding: clamp(24px, 4vw, 56px); }
@media (max-width: 640px) {
  .layout { display: block; }
  aside { border: 0; border-bottom: 1px solid var(--line); padding: 12px 24px; }
  nav { display: inline-block; margin: 0 0 0 16px; }
  button { min-height: 44px; }
}
</style>
