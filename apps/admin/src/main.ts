import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import ManagementPage from './management/ManagementPage.vue';
import StudentImports from './management/StudentImports.vue';
import StudentsPage from './management/StudentsPage.vue';
import { sectionKeys } from './management/sections';
import SchedulePage from '@hongyan/ui/SchedulePage.vue';
import TaskInbox from './TaskInbox.vue';
import ReviewPage from './activities/ReviewPage.vue';
import HourReview from './hours/HourReview.vue';
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
        { path: 'hours/:id?', component: HourReview },
        { path: 'reviews/:id?', component: ReviewPage, meta: { profile: true } },
        { path: 'manage/imports/:item?', component: StudentImports },
        { path: 'manage/students/:item?', component: StudentsPage },
        {
          path: 'manage/:section(' + sectionKeys.join('|') + ')/:item?',
          component: ManagementPage,
          meta: { profile: true },
        },
      ],
    },
  ],
});

createApp(App).use(router).mount('#app');
