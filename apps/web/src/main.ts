import { createApp } from 'vue';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import {router} from './router';
import App from './App.vue';

createApp(App).use(router).mount('#app');
