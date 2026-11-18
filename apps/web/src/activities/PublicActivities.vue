<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { listActivities,getActivity,type Activity } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
const route=useRoute(),router=useRouter(),rows=ref<Activity[]>([]),detail=ref<Activity>(),total=ref(0),busy=ref(false),error=ref('');
const date=(s?:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
let serial=0;
async function load(){
 const index=++serial;busy.value=true;error.value='';detail.value=undefined;rows.value=[];
 try{
  if(route.params.id){const response=await getActivity({path:{id:String(route.params.id)},throwOnError:true});if(index===serial) detail.value=response.data.data;}
  else {const response=await listActivities({query:{scope:'public',page:Number(route.query.page||1),q:String(route.query.q??'')},throwOnError:true});
   if(index===serial){rows.value=response.data.data.items;total.value=response.data.data.total;}}
 }catch(e){if(index===serial) error.value=e instanceof Error?e.message:'读取失败';}
 finally{if(index===serial)busy.value=false;}
}
watch(()=>route.fullPath,load,{immediate:true});
</script>
<template>
 <RouterLink v-if="route.params.id" :to="{path:'/',query:route.query}">返回活动列表</RouterLink>
 <h1>{{detail?.title || (route.params.id?'活动详情':'活动')}}</h1>
 <p v-if="busy" role="status">正在读取…</p><p v-else-if="error" role="alert">{{error}} <button @click="load">重试</button></p>
 <article v-else-if="detail"><p>{{detail.description}}</p>
 <dl><dt>服务对象</dt><dd>{{detail.beneficiaries}}</dd><dt>活动时间</dt><dd>{{date(detail.starts_at)}} 至 {{date(detail.ends_at)}}</dd>
 <dt>活动地点</dt><dd>{{detail.campus}} · {{detail.location}}</dd><dt>集合与交通</dt><dd>{{detail.meeting_point}} · {{detail.transport_notes}}</dd>
 <dt>报名时间</dt><dd>{{date(detail.registration_opens_at)}} 至 {{date(detail.registration_closes_at)}}</dd>
 <dt>名额及条件</dt><dd>{{detail.capacity}} 人 · {{detail.eligibility_text}}</dd><dt>录取与结果公布</dt><dd>{{detail.selection_text}} · {{date(detail.result_expected_at)}}</dd>
 <dt>时长认定</dt><dd>{{detail.hours_rule_text}} <span v-if="detail.expected_hours">{{detail.expected_hours}} 小时（{{detail.expected_hours_basis==='whole_activity'?'整期':'单次'}}）</span></dd>
 <template v-if="detail.group_join_instructions"><dt>入群方式</dt><dd>{{detail.group_join_instructions}}</dd></template></dl>
 <p>本活动统一报名，录取后查看入群方式。<span v-if="detail.schedule.schedule_type==='weekly'">每周参加报名在活动群内完成。</span></p>
 <button disabled>{{detail.my_registration_status==='accepted'?'已录取':detail.my_registration_status==='submitted'?'已提交，待审核':'申请报名'}}</button> <small>报名功能待接入</small>
 </article>
 <template v-else><label>查找活动 <input :value="route.query.q" @change="router.push({path:'/',query:{q:($event.target as HTMLInputElement).value}})"></label>
 <ul><li v-for="row in rows" :key="row.id"><RouterLink :to="{path:'/activities/'+row.id,query:route.query}">{{row.title}}</RouterLink> · {{row.location}}</li></ul>
 <p v-if="!rows.length">暂无匹配的公开活动</p>
 <Pager :page="Number(route.query.page||1)" :size="20" :total="total" @change="page=>router.push({query:{...route.query,page}})" /></template>
</template>
