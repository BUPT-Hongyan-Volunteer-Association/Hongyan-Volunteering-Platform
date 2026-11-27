import { createRouter, createWebHistory } from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
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

const loadActivityEditor = () => import('./activities/ActivityEditor.vue');
const loadSchedulePage = () => import('@hongyan/ui/SchedulePage.vue');

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PublicActivities, meta: {title: '活动发现', nav: '/',  profile: true } },
    { path: '/activities/:id', component: PublicActivities, meta: {title: '活动详情', nav: '/',  profile: true } },
    { path: '/managed', component: () => import('./activities/ManagedActivities.vue'), meta: {title: '我的管理活动', nav: '/managed',  organizer: true } },
    { path: '/managed/new', component: loadActivityEditor, meta: {title: '新建活动', nav: '/managed/new',  organizer: true } },
    {
      path: '/managed/:id',
      name: 'managed-overview',
      component: () => import('./activities/ActivityWorkspace.vue'),
      meta: {title: '活动工作区', nav: '/managed',  organizer: true, profile: true },
      children: [
        {
          path: ':area(requests)/:item?',
          name: 'organizer-section',
          component: () => import('./registrations/RequestWorkspace.vue'),
          props: route => ({ activityId: String(route.params.id), requestId: route.params.item || undefined }),
          meta: { area: 'requests' },
        },
        { path: 'edit', name: 'activity-edit', component: loadActivityEditor, meta: { area: 'edit' } },
        { path: 'notices/:item?', name: 'activity-notices', component: () => import('./notices/ActivityNotices.vue'), meta: { area: 'notices' } },
        { path: 'roster', name: 'roster', component: () => import('./registrations/Roster.vue'), meta: { area: 'roster' } },
        { path: 'attendance', name: 'activity-attendance', component: () => import('./attendance/AttendanceRecords.vue'), meta: { area: 'attendance' } },
        { path: 'batches', name: 'hour-batches', component: () => import('./hours/HourBatches.vue'), meta: { area: 'batches' } },
        { path: 'batches/:item', name: 'hour-batch', component: () => import('./hours/HourBatchDetail.vue'), meta: { area: 'batches' } },
        { path: 'hours', name: 'activity-hours', component: () => import('./hours/ActivityHours.vue'), meta: { area: 'hours' } },
        { path: 'corrections/:item?', name: 'activity-hour-corrections', component: () => import('@hongyan/ui/HourCorrectionGroups.vue'), meta: { area: 'hours' } },
        { path: 'appeals/:item?', name: 'activity-hour-appeals', component: () => import('@hongyan/ui/HourAppeals.vue'), props: { mode: 'organizer' }, meta: { area: 'hours' } },
        { path: 'incidents', name: 'activity-hour-incidents', component: () => import('@hongyan/ui/HourIncidents.vue'), props: { mode: 'organizer' }, meta: { area: 'attendance' } },
      ],
    },
    {
      path: '/schedule',
      component: loadSchedulePage,
      props: { scope: 'public' },
      meta: {title: '活动日程', nav: '/schedule',  studentSchedule: true },
    },
    {
      path: '/mine/schedule',
      component: loadSchedulePage,
      props: { scope: 'mine' },
      meta: {title: '活动日程', nav: '/schedule',  personal: true, studentSchedule: true },
    },
    {
      path: '/managed-schedule',
      component: loadSchedulePage,
      props: { scope: 'managed' },
      meta: {title: '管理日程', nav: '/managed-schedule',  organizer: true },
    },
    { path: '/mine', component: () => import('./PersonalPage.vue'), meta: {title: '我的', nav: '/mine',  profile: true, personal: true } },
    { path: '/mine/settings', component: () => import('./AccountSettings.vue'), meta: {title: '账号管理', nav: '/mine',  profile: true, personal: true } },
    {
      path: '/registrations/:item?',
      name: 'registrations',
      component: () => import('./registrations/MyRegistrations.vue'),
      meta: {title: '我的报名', nav: '/registrations',  personal: true },
    },
    {
      path: '/notices/:item?',
      name: 'notices',
      component: () => import('./notices/MyNotices.vue'),
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
