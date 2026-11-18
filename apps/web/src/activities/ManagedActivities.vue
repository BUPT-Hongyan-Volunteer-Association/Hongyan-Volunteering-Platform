<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getActivityMembers, listManagedActivities, type Activity, type ActivityMember } from '@hongyan/contracts';

const activities=ref<Activity[]>([]), members=ref<ActivityMember[]>([]), selected=ref(''), error=ref(''), loading=ref(true);
async function load() {
 loading.value=true;error.value='';members.value=[];activities.value=[];
 try{activities.value=(await listManagedActivities({query:{scope:'managed'},throwOnError:true})).data.data.items;}
 catch(e){error.value=e instanceof Error?e.message:'读取失败';}
 finally{loading.value=false;}
}
async function select(id:string) {
 selected.value=id;members.value=[];error.value='';
 try{const result=await getActivityMembers({path:{id},throwOnError:true});if(selected.value===id) members.value=result.data.data.items;}
 catch(e){if(selected.value===id) error.value=e instanceof Error?e.message:'读取失败';}
}
onMounted(load);
</script>
<template>
 <h2>我的管理活动</h2><RouterLink to="/managed/new">新建单次活动</RouterLink>
 <p v-if="loading">正在读取活动…</p><p v-else-if="error" role="alert">{{error}} <button @click="load">刷新</button></p>
 <p v-else-if="!activities.length">暂无可管理的活动</p>
 <ul><li v-for="a in activities" :key="a.id"><button @click="select(a.id)">{{a.title}}</button> <RouterLink :to="'/managed/'+a.id+'/edit'">编辑与送审</RouterLink> · <RouterLink :to="'/managed/'+a.id+'/roster'">报名名单</RouterLink></li></ul>
 <ul aria-label="活动成员"><li v-for="m in members" :key="m.account_id">{{m.display_name}} · {{m.member_role==='owner'?'主负责人':'协作者'}}</li></ul>
</template>
