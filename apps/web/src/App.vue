<script setup lang="ts">
import { studentNav, managedNav } from './router';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { Profile } from '@hongyan/contracts';
import { hasStudentAccess } from './identity';
import AccountGate from '@hongyan/ui/AccountGate.vue';
import NoticeBadge from './notices/NoticeBadge.vue';
import AccountIdentity from '@hongyan/ui/AccountIdentity.vue';
import BrandName from '@hongyan/ui/BrandName.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';

const route = useRoute();
const canManage = (profile: Profile) => profile.roles.includes('organizer');
const isCurrent = (to: string) => route.meta.nav === to;
const crumb = computed(() => route.meta.title);
</script>
<template>
  <AccountGate v-slot="{ profile, busy, logout }">
    <div
      class="app-shell student-shell"
      :class="{
        detailRoute: $route.path.startsWith('/activities/'),
        scheduleRoute: !!$route.meta.studentSchedule,
      }"
    >
      <aside class="app-rail web-rail">
        <BrandName :area="canManage(profile) ? '活动负责人' : '学生端'" />
        <nav class="rail-nav" aria-label="学生导航">
          <RouterLink
            v-for="item in hasStudentAccess(profile) ? studentNav : studentNav.slice(0, 1)"
            :key="item.to"
            :to="item.to"
            :aria-label="item.label"
            :aria-describedby="item.to === '/notices' ? 'notice-attention-description' : undefined"
            :class="{ current: isCurrent(item.to) }"
            :aria-current="isCurrent(item.to) ? 'page' : undefined"
          >
            <UiIcon :name="item.icon" /><span>{{ item.label }}</span>
            <NoticeBadge v-if="item.to === '/notices'" />
          </RouterLink>
          <RouterLink
            v-if="canManage(profile)"
            class="mobile-management"
            to="/managed"
            :class="{ current: $route.meta.organizer }"
            :aria-current="$route.meta.organizer ? 'page' : undefined"
          >
            <UiIcon name="FolderOpened" /><span>管理</span>
          </RouterLink>
        </nav>
        <nav
          v-if="canManage(profile)"
          class="rail-nav management-links"
          aria-labelledby="management-label"
        >
          <h2 id="management-label">活动管理</h2>
          <RouterLink
            v-for="item in managedNav"
            :key="item.to"
            :to="item.to"
            :class="{ current: isCurrent(item.to) }"
            :aria-current="isCurrent(item.to) ? 'page' : undefined"
          >
            <UiIcon :name="item.icon" /><span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </aside>
      <div class="workspace">
        <header class="shell-top">
          <div class="crumbs">
            <span>{{ $route.meta.organizer && canManage(profile) ? '活动管理' : '学生端' }}</span
            ><UiIcon name="ArrowRight" /><strong>{{ crumb }}</strong>
          </div>
          <div class="mobile-brand"><BrandName /></div>
          <AccountIdentity :name="profile.display_name" :busy="busy" @logout="logout" />
        </header>
        <main class="shell-content">
          <p v-if="$route.meta.organizer && !canManage(profile)" role="alert">
            当前账号无活动管理权限
          </p>
          <p v-else-if="$route.meta.personal && !hasStudentAccess(profile)" role="alert">
            当前账号无学生个人页面权限
          </p>
          <RouterView v-else v-slot="{ Component }"
            ><component
              :is="Component"
              v-bind="
                $route.meta.profile
                  ? { profile }
                  : $route.meta.studentSchedule
                    ? { showPersonalScope: hasStudentAccess(profile) }
                    : {}
              "
          /></RouterView>
        </main>
      </div>
    </div>
  </AccountGate>
</template>
<style scoped>
.management-links {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.management-links h2 {
  margin: 0 14px 4px;
  font-size: 13px;
  font-weight: 550;
  color: var(--muted);
}
.rail-nav .mobile-management {
  display: none;
}
@media (max-width: 700px) {
  .web-rail {
    position: fixed;
    z-index: 5;
    inset: auto 0 0;
    height: auto;
    padding: 3px 4px max(3px, env(safe-area-inset-bottom));
    background: white;
    border: 0;
    border-top: 1px solid var(--line);
  }
  .web-rail > .brand,
  .web-rail .management-links,
  .crumbs {
    display: none;
  }
  .rail-nav {
    display: flex;
    gap: 0;
  }
  .rail-nav a,
  .rail-nav .mobile-management {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 5px 2px;
    min-height: 50px;
    font-size: 12px;
  }
  .rail-nav .ui-icon {
    width: 21px;
    height: 21px;
  }
  .rail-nav a.current {
    background: var(--brand-tint);
  }
  .scheduleRoute .shell-top {
    display: none;
  }
  .scheduleRoute .shell-content {
    padding-top: 8px;
  }
  .detailRoute .web-rail,
  .detailRoute .shell-top {
    display: none;
  }
  .detailRoute .shell-content {
    padding: 0 16px 16px;
  }
}
</style>
