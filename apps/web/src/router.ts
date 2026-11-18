import {createRouter,createWebHistory} from 'vue-router';
import PublicActivities from './activities/PublicActivities.vue';
import ManagedActivities from './activities/ManagedActivities.vue';
import Roster from './registrations/Roster.vue';
import PersonalPage from './PersonalPage.vue';
export const router=createRouter({history:createWebHistory(),routes:[
 {path:'/',component:PublicActivities},{path:'/activities/:id',component:PublicActivities},
 {path:'/managed',component:ManagedActivities,meta:{organizer:true}},
 {path:'/managed/:id/roster',component:Roster,meta:{organizer:true}},
 {path:'/mine',component:PersonalPage},{path:'/registrations',component:PersonalPage},{path:'/notices',component:PersonalPage}
]});
