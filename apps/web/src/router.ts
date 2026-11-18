import { createRouter, createWebHistory } from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
import ActivityEditor from './activities/ActivityEditor.vue';
import ActivityWorkspace from './activities/ActivityWorkspace.vue';
import Roster from './registrations/Roster.vue';
import PersonalPage from './PersonalPage.vue';
import StudentRecords from './personal/StudentRecords.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PublicActivities },
    { path: '/activities/:id', component: PublicActivities },
    { path: '/managed', component: ManagedActivities, meta: { organizer: true } },
    { path: '/managed/new', component: ActivityEditor, meta: { organizer: true } },
    {
      path: '/managed/:id',
      name: 'managed-overview',
      component: ActivityWorkspace,
      meta: { organizer: true, profile: true },
      children: [
        { path: 'edit', component: ActivityEditor },
        { path: 'roster', name: 'roster', component: Roster },
      ],
    },
    { path: '/mine', component: PersonalPage, meta: { profile: true } },
    { path: '/mine/settings', component: PersonalPage, meta: { profile: true } },
    { path: '/mine/example-activity', component: PersonalPage, meta: { profile: true } },
    { path: '/registrations/:item?', name: 'registrations', component: StudentRecords },
    { path: '/notices/:item?', name: 'notices', component: StudentRecords },
    { path: '/mine/hours/:item?', name: 'hours', component: StudentRecords },
    { path: '/mine/feedback/:item?', name: 'feedback', component: StudentRecords },
  ],
});
