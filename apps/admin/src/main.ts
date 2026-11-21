import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import ManagementPage from './management/ManagementPage.vue';
import StudentImports from './management/StudentImports.vue';
import StudentsPage from './management/StudentsPage.vue';
import { previewSectionKeys } from './management/sections';
import SchedulePage from '@hongyan/ui/SchedulePage.vue';
import TaskInbox from './TaskInbox.vue';
import ReviewPage from './activities/ReviewPage.vue';
import App from './App.vue';
import BasicLayout from './layouts/BasicLayout.vue';
import SessionStatus from '@hongyan/ui/SessionStatus.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: BasicLayout,
      children: [
        { path: '', component: TaskInbox },
        { path: 'schedule', component: SchedulePage, props: { scope: 'all' } },
        { path: 'connection', name: 'connection', component: SessionStatus },
        { path: 'hours/:id?', component: () => import('./hours/HourReview.vue'), meta: { profile: true } },
        { path: 'reviews/:id?', component: ReviewPage, meta: { profile: true } },
        { path: 'manage/imports/:item?', component: StudentImports },
        { path: 'manage/students/:item?', component: StudentsPage },
        { path: 'manage/students/:item/hours', component: () => import('./hours/StudentHours.vue') },
        { path: 'manage/corrections/:item?', component: () => import('@hongyan/ui/HourCorrectionGroups.vue'), props: { admin: true }, meta: { profile: true } },
        { path: 'manage/appeals/:item?', component: () => import('@hongyan/ui/HourAppeals.vue'), props: { mode: 'admin' } },
        { path: 'manage/incidents', component: () => import('@hongyan/ui/HourIncidents.vue'), props: { mode: 'admin' } },
        {
          path: 'manage/:section(' + previewSectionKeys.join('|') + ')/:item?',
          component: ManagementPage,
          meta: { profile: true },
        },
      ],
    },
  ],
});

createApp(App).use(router).mount('#app');
