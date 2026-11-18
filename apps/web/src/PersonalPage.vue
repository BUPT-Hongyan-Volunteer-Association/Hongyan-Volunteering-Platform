<script setup lang="ts">
import type { Profile } from '@hongyan/contracts';
import { personalRecords, title } from './personal/examples';
defineProps<{ profile: Profile }>();
</script>
<template>
  <template v-if="$route.path === '/mine/settings'">
    <RouterLink to="/mine">返回我的</RouterLink><h1>账号设置</h1>
    <dl><dt>姓名</dt><dd>{{ profile.display_name }}</dd><dt>登录账号</dt><dd>{{ profile.username }}</dd>
      <template v-if="profile.student"><dt>学号</dt><dd>{{ profile.student.student_no }}</dd></template></dl>
  </template>
  <template v-else-if="$route.path === '/mine/example-activity'">
    <RouterLink :to="'/registrations/' + personalRecords.registrations[0].id">返回报名详情</RouterLink>
    <p class="sample-label">示例数据 · 获批活动</p><h1>{{ title }}</h1><dl><dt>服务地点</dt><dd>沙河校区图书馆</dd><dt>服务安排</dt><dd>11 月 14、15、21 日整理归还书籍</dd><dt>参与方式</dt><dd>整项活动统一报名</dd></dl>
  </template>
  <template v-else><h1>我的</h1><p>{{ profile.display_name }} · {{ profile.username }}</p>
    <div class="entry-list"><RouterLink to="/mine/hours">我的时长</RouterLink><RouterLink to="/mine/feedback">本人记录与反馈</RouterLink><RouterLink to="/mine/settings">账号设置</RouterLink>
      <RouterLink v-if="profile.roles.includes('organizer')" to="/managed">活动管理</RouterLink></div>
  </template>
</template>
