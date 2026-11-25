import { createRouter, createWebHistory } from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
import ActivityEditor from './activities/ActivityEditor.vue';
import RequestWorkspace from './registrations/RequestWorkspace.vue';
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
export const studentNav = [
  { to: '/', label: '活动发现', icon: 'Search' },
  { to: '/schedule', label: '活动日程', icon: 'Calendar' },
  { to: '/registrations', label: '我的报名', icon: 'Tickets' },
  { to: '/notices', label: '通知', icon: 'Bell' },
  { to: '/mine', label: '我的', icon: 'User' },
] as const;
export const managedNav = [
  { to: '/managed', label: '我的管理活动', icon: 'FolderOpened' },
  { to: '/managed/new', label: '新建活动', icon: 'Plus' },
  { to: '/managed-schedule', label: '管理日程', icon: 'Clock' },
] as const;
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PublicActivities, meta: {title: '活动发现', nav: '/',  profile: true } },
    { path: '/activities/:id', component: PublicActivities, meta: {title: '活动详情', nav: '/',  profile: true } },
    { path: '/managed', component: ManagedActivities, meta: {title: '我的管理活动', nav: '/managed',  organizer: true } },
    { path: '/managed/new', component: ActivityEditor, meta: {title: '新建活动', nav: '/managed/new',  organizer: true } },
    {
      path: '/managed/:id',
      name: 'managed-overview',
      component: ActivityWorkspace,
      meta: {title: '活动工作区', nav: '/managed',  organizer: true, profile: true },
      children: [
        {
          path: ':area(requests)/:item?',
          name: 'organizer-section',
          component: RequestWorkspace,
          props: route => ({ activityId: String(route.params.id), requestId: route.params.item || undefined }),
          meta: { area: 'roster' },
        },
        { path: 'edit', name: 'activity-edit', component: ActivityEditor, meta: { area: 'edit' } },
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
      meta: {title: '活动日程', nav: '/schedule',  studentSchedule: true },
    },
    {
      path: '/mine/schedule',
      component: SchedulePage,
      props: { scope: 'mine' },
      meta: {title: '活动日程', nav: '/schedule',  personal: true, studentSchedule: true },
    },
    {
      path: '/managed-schedule',
      component: SchedulePage,
      props: { scope: 'managed' },
      meta: {title: '管理日程', nav: '/managed-schedule',  organizer: true },
    },
    { path: '/mine', component: PersonalPage, meta: {title: '我的', nav: '/mine',  profile: true, personal: true } },
    { path: '/mine/settings', component: () => import('./AccountSettings.vue'), meta: {title: '账号管理', nav: '/mine',  profile: true, personal: true } },
    {
      path: '/registrations/:item?',
      name: 'registrations',
      component: MyRegistrations,
      meta: {title: '我的报名', nav: '/registrations',  personal: true },
    },
    {
      path: '/notices/:item?',
      name: 'notices',
      component: MyNotices,
      meta: {title: '通知', nav: '/notices',  personal: true },
    },
    {
      path: '/mine/hours/:item?',
      name: 'hours',
      component: () => import('./hours/MyHours.vue'),
      meta: {title: '我的时长', nav: '/mine',  personal: true },
    },
    {
      path: '/mine/feedback/:item?',
      name: 'feedback',
      component: () => import('./hours/MyFeedback.vue'),
      meta: {title: '本人记录与反馈', nav: '/mine',  personal: true },
    },
  ],
});
