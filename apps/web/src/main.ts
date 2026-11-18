import { createApp } from 'vue';
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/button/style/css';
import '@hongyan/ui/theme.css';
import '@hongyan/ui/pages.css';
import {router} from './router';
import App from './App.vue';

createApp(App).use(router).mount('#app');
