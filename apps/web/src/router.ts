import { createRouter, createWebHistory } from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
import ActivityEditor from './activities/ActivityEditor.vue';
import RequestQueue from './registrations/RequestQueue.vue';
import AttendanceRecords from './attendance/AttendanceRecords.vue';
import HourBatches from './hours/HourBatches.vue';
import HourBatchDetail from './hours/HourBatchDetail.vue';
import ActivityWorkspace from './activities/ActivityWorkspace.vue';
import MyRegistrations from './registrations/MyRegistrations.vue';
import Roster from './registrations/Roster.vue';
import PersonalPage from './PersonalPage.vue';
import ActivityNotices from './notices/ActivityNotices.vue';
import MyNotices from './notices/MyNotices.vue';
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
          path: ':area(requests)/:item?',
          name: 'organizer-section',
          component: RequestQueue,
          props: route => ({ activityId: String(route.params.id), requestId: route.params.item || undefined }),
          meta: { area: 'roster' },
        },
        { path: 'edit', name: 'activity-edit', component: ActivityEditor },
        { path: 'notices/:item?', name: 'activity-notices', component: ActivityNotices, meta: { area: 'notices' } },
        { path: 'roster', name: 'roster', component: Roster, meta: { area: 'roster' } },
        { path: 'attendance', name: 'activity-attendance', component: AttendanceRecords, meta: { area: 'attendance' } },
        { path: 'batches', name: 'hour-batches', component: HourBatches, meta: { area: 'batches' } },
        { path: 'batches/:item', name: 'hour-batch', component: HourBatchDetail, meta: { area: 'batches' } },
        { path: 'hours', name: 'activity-hours', component: () => import('./hours/ActivityHours.vue'), meta: { area: 'hours' } },
        { path: 'corrections/:item?', name: 'activity-hour-corrections', component: () => import('@hongyan/ui/HourCorrectionGroups.vue'), meta: { area: 'hours' } },
        { path: 'appeals/:item?', name: 'activity-hour-appeals', component: () => import('@hongyan/ui/HourAppeals.vue'), props: { mode: 'organizer' }, meta: { area: 'hours' } },
        { path: 'incidents', name: 'activity-hour-incidents', component: () => import('@hongyan/ui/HourIncidents.vue'), props: { mode: 'organizer' }, meta: { area: 'attendance' } },
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
      component: MyNotices,
      meta: { personal: true },
    },
    {
      path: '/mine/hours/:item?',
      name: 'hours',
      component: () => import('./hours/MyHours.vue'),
      meta: { personal: true },
    },
    {
      path: '/mine/feedback/:item?',
      name: 'feedback',
      component: () => import('./hours/MyFeedback.vue'),
      meta: { personal: true },
    },
  ],
});
