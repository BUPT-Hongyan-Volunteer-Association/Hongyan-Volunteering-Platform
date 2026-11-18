<!-- Vue Vben Admin v5.7.0, layout-ui 的 sidebar-nav 布局。上游许可见 LICENSE。 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import LayoutHeader from './layout-header.vue';

const media = window.matchMedia('(max-width: 640px)');
const isMobile = ref(media.matches);
const sidebarCollapse = ref(false);
const sidebarWidth = 216;
const headerHeight = 64;
const updateViewport = () => { isMobile.value = media.matches; };

watch(isMobile, (mobile) => { sidebarCollapse.value = mobile; }, { immediate: true });
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
      <LayoutHeader :full-width="false" :height="headerHeight" :is-mobile="isMobile"
        :show="true" :sidebar-width="sidebarWidth" theme="toolbar" width="100%" :z-index="1">
        <template #toggle-button>
          <button type="button" aria-controls="vben-sidebar" :aria-expanded="!sidebarCollapse"
            @click="sidebarCollapse = !sidebarCollapse">{{ sidebarCollapse ? '展开导航' : '收起导航' }}</button>
        </template>
        <slot name="header" />
      </LayoutHeader>
      <main id="__vben_main_content"><slot name="content" /></main>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: v-bind("sidebarWidth + 'px'") minmax(0, 1fr); min-height: 100vh; }
.layout.collapsed { grid-template-columns: minmax(0, 1fr); }
aside { background: var(--surface); padding: 20px 16px; border-right: 1px solid var(--line); }
nav { margin-top: 40px; }
.toolbar { display: flex; align-items: center; gap: 16px; padding: 0 24px;
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
