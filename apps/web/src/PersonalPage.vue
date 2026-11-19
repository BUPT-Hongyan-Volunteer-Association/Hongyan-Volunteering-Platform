<script setup lang="ts">
import type { Profile } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
defineProps<{ profile: Profile }>();
const entries = [
  { to: '/mine/schedule', label: '我的日程', icon: 'Calendar' },
  { to: '/mine/hours', label: '我的时长', icon: 'Clock' },
  { to: '/mine/feedback', label: '本人记录与反馈', icon: 'ChatLineSquare' },
  { to: '/mine/settings', label: '账号设置', icon: 'Setting' },
] as const;
</script>
<template>
  <template v-if="$route.path === '/mine/settings'">
    <RouterLink class="back-link" to="/mine"><UiIcon name="ArrowLeft" />返回我的</RouterLink>
    <h1>账号设置</h1>
    <dl class="detail-fields">
      <dt>姓名</dt>
      <dd>{{ profile.display_name }}</dd>
      <dt>登录账号</dt>
      <dd>{{ profile.username }}</dd>
      <template v-if="profile.student"
        ><dt>学号</dt>
        <dd>{{ profile.student.student_no }}</dd></template
      >
    </dl>
  </template>
  <template v-else>
    <h1>我的</h1>
    <div class="profile-strip">
      <span class="avatar" aria-hidden="true">{{ profile.display_name.slice(0, 1) }}</span>
      <div>
        <h2>{{ profile.display_name }}</h2>
        <span class="meta-line"
          >{{ profile.student ? '学号' : '账号' }} {{ profile.username }}</span
        >
      </div>
      <RouterLink
        v-if="profile.roles.includes('organizer')"
        class="button manager-entry"
        to="/managed"
        ><UiIcon name="FolderOpened" />活动管理</RouterLink
      >
    </div>
    <div class="entry-list personal-entries">
      <RouterLink v-for="entry in entries" :key="entry.to" :to="entry.to">
        <span class="item-icon"><UiIcon :name="entry.icon" /></span
        ><strong>{{ entry.label }}</strong
        ><UiIcon name="ArrowRight" class="row-arrow" />
      </RouterLink>
    </div>
  </template>
</template>
<style scoped>
.profile-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 20px;
}
.profile-strip h2 {
  margin: 0 0 3px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  background: var(--brand);
  color: white;
  border-radius: 50%;
  font-weight: 650;
  font-size: 20px;
}
.manager-entry {
  margin-left: auto;
}
.row-arrow {
  margin-left: auto;
  width: 15px;
  color: var(--muted);
}
.personal-entries strong {
  font-weight: 550;
}
</style>
