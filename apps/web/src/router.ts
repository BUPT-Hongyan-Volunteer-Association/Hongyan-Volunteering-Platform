import { createRouter, createWebHistory } from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
import ActivityEditor from './activities/ActivityEditor.vue';
import OrganizerSection from './activities/OrganizerSection.vue';
import HourBatches from './hours/HourBatches.vue';
import HourBatchDetail from './hours/HourBatchDetail.vue';
import ActivityWorkspace from './activities/ActivityWorkspace.vue';
import MyRegistrations from './registrations/MyRegistrations.vue';
import Roster from './registrations/Roster.vue';
import PersonalPage from './PersonalPage.vue';
import NoticeInbox from './personal/NoticeInbox.vue';
import StudentRecords from './personal/StudentRecords.vue';
import SchedulePage from '@hongyan/ui/SchedulePage.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PublicActivities, meta: { profile: true } },
    { path: '/activities/:id', component: PublicActivities, meta: { profile: true } },
    { path: '/managed', component: ManagedActivities, meta: { organizer: true, profile: true } },
    { path: '/managed/new', component: ActivityEditor, meta: { organizer: true } },
    {
      path: '/managed/:id',
      name: 'managed-overview',
      component: ActivityWorkspace,
      meta: { organizer: true, profile: true },
      children: [
        {
          path: ':area(requests|notices|attendance|appeals|corrections|incidents)/:item?',
          name: 'organizer-section',
          component: OrganizerSection,
        },
        { path: 'edit', name: 'activity-edit', component: ActivityEditor },
        { path: 'roster', name: 'roster', component: Roster },
        { path: 'batches', name: 'hour-batches', component: HourBatches },
        { path: 'batches/:item', name: 'hour-batch', component: HourBatchDetail },
      ],
    },
    {
      path: '/schedule',
      component: SchedulePage,
      props: { scope: 'public' },
      meta: { studentSchedule: true },
    },
    {
      path: '/mine/schedule',
      component: SchedulePage,
      props: { scope: 'mine' },
      meta: { personal: true, studentSchedule: true },
    },
    {
      path: '/managed-schedule',
      component: SchedulePage,
      props: { scope: 'managed' },
      meta: { organizer: true },
    },
    { path: '/mine', component: PersonalPage, meta: { profile: true, personal: true } },
    { path: '/mine/settings', component: PersonalPage, meta: { profile: true, personal: true } },
    {
      path: '/mine/example-activity',
      redirect: '/registrations',
    },
    {
      path: '/registrations/:item?',
      name: 'registrations',
      component: MyRegistrations,
      meta: { personal: true },
    },
    {
      path: '/notices/:item?',
      name: 'notices',
      component: NoticeInbox,
      meta: { personal: true },
    },
    {
      path: '/mine/hours/:item?',
      name: 'hours',
      component: StudentRecords,
      meta: { personal: true },
    },
    {
      path: '/mine/feedback/:item?',
      name: 'feedback',
      component: StudentRecords,
      meta: { personal: true },
    },
  ],
});
