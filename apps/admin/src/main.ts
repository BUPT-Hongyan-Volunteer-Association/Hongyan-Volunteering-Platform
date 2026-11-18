import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import ReviewPage from './activities/ReviewPage.vue';
import HourReview from './hours/HourReview.vue';
import App from './App.vue';
import BasicLayout from './layouts/BasicLayout.vue';
import SessionStatus from '@hongyan/ui/SessionStatus.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [{
    path: '/',
    component: BasicLayout,
    children: [{path:'',redirect:'/reviews'}, { path: 'connection', name: 'connection', component: SessionStatus },{path:'hours/:id?', component:HourReview},{path:'reviews/:id?',component:ReviewPage}],
  }],
});

createApp(App).use(router).mount('#app');
