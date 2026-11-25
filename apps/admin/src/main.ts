import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import TaskInbox from './TaskInbox.vue';
import App from './App.vue';
import BasicLayout from './layouts/BasicLayout.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: BasicLayout,
      children: [
        { path: '', component: TaskInbox, meta: { section: 'inbox' } },
        { path: 'schedule', component: () => import('@hongyan/ui/SchedulePage.vue'), props: { scope: 'all' }, meta: { section: 'schedule' } },
        { path: 'hours/:id?', component: () => import('./hours/HourReview.vue'), meta: { section: 'hours', profile: true } },
        { path: 'reviews/:id?', component: () => import('./activities/ReviewPage.vue'), meta: { section: 'reviews', profile: true } },
        { path: 'manage/imports/:item?', component: () => import('./management/StudentImports.vue'), meta: { section: 'students', title: '学生建档导入' } },
        { path: 'manage/teams', component: () => import('./activities/TeamsPage.vue'), meta: { section: 'teams' } },
        { path: 'manage/teams/:id', component: () => import('./activities/TeamDetail.vue'), props: true, meta: { section: 'teams' } },
        { path: 'manage/accounts/:item?', component: () => import('./management/AccountLookup.vue'), meta: { section: 'accounts', profile: true } },
        { path: 'manage/students', component: () => import('./management/StudentsPage.vue'), meta: { section: 'students' } },
        { path: 'manage/students/:item/hours', component: () => import('./hours/StudentHours.vue'), meta: { section: 'students', title: '学生时长' } },
        { path: 'manage/audit', component: () => import('./management/AuditPage.vue'), meta: { section: 'audit' } },
        { path: 'manage/corrections/:item?', component: () => import('@hongyan/ui/HourCorrectionGroups.vue'), props: { admin: true }, meta: { section: 'corrections', profile: true } },
        { path: 'manage/appeals/:item?', component: () => import('@hongyan/ui/HourAppeals.vue'), props: { mode: 'admin' }, meta: { section: 'appeals' } },
        { path: 'manage/incidents', component: () => import('@hongyan/ui/HourIncidents.vue'), props: { mode: 'admin' }, meta: { section: 'incidents' } },
        { path: 'manage/failures/:item?', component: () => import('./management/NotificationFailures.vue'), meta: { section: 'failures' } },
      ],
    },
  ],
});

createApp(App).use(router).mount('#app');