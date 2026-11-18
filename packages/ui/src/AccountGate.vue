<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { ApiError, changePassword, getProfile, login, logout, openSession, writeHeaders, type Profile } from '@hongyan/contracts';

const props=defineProps<{admin?:boolean}>();
const stage=ref<'loading'|'failed'|'login'|'change'|'ready'>('loading');
const profile=ref<Profile>();
const username=ref(''), password=ref(''), next=ref(''), message=ref(''), busy=ref(false);
async function restore() {
  stage.value='loading';
  profile.value=undefined;
  message.value='';
  try {
    await openSession();
    profile.value=(await getProfile({throwOnError:true})).data.data;
    stage.value='ready';
  } catch(e) {
    if(e instanceof ApiError && e.status===401) stage.value='login';
    else if(e instanceof ApiError && e.body?.code==='password_change_required') stage.value='change';
    else {stage.value='failed';message.value=e instanceof Error?e.message:'无法读取身份';}
  }
}
async function submit(action:'login'|'change'|'logout') {
  if(busy.value) return;
  busy.value=true; message.value='';
  try {
    const headers=writeHeaders();
    if(action==='login') await login({headers,body:{username:username.value,password:password.value},throwOnError:true});
    if(action==='change') await changePassword({headers,body:{current_password:password.value,new_password:next.value},throwOnError:true});
    if(action==='logout') await logout({headers,throwOnError:true});
    password.value=''; next.value='';
    await restore();
  } catch(e) {
    if(e instanceof ApiError && e.status===401 && action!=='login') await restore();
    message.value=e instanceof Error?e.message:'请求失败';
  } finally {busy.value=false;}
}
function expired() {
  if (stage.value==='ready' || stage.value==='change') void restore();
}
async function refreshIdentity() {
  if(stage.value!=='ready' || busy.value)return;
  const current=profile.value?.account_id;
  try{
    const result=(await getProfile({throwOnError:true})).data.data;
    if(stage.value==='ready' && profile.value?.account_id===current)profile.value=result;
  }catch(e){if(e instanceof ApiError && e.body?.code==='password_change_required') await restore();}
}
onMounted(()=>{window.addEventListener('focus',refreshIdentity);window.addEventListener('hongyan-session-expired',expired); void restore();});
onUnmounted(()=>{window.removeEventListener('focus',refreshIdentity);window.removeEventListener('hongyan-session-expired',expired);});
</script>
<template>
  <p v-if="stage==='loading'" role="status">正在读取会话…</p>
  <section v-else-if="stage==='failed'"><h2>连接失败</h2><button @click="restore">重试</button></section>
  <form v-else-if="stage==='login' || stage==='change'" class="credentials" @submit.prevent="submit(stage)">
    <h2>{{ stage==='login'?'登录':'首次登录，请修改密码' }}</h2>
    <label v-if="stage==='login'">账号<input v-model="username" required autocomplete="username"></label>
    <label>当前密码<input v-model="password" type="password" required autocomplete="current-password"></label>
    <label v-if="stage==='change'">新密码<input v-model="next" type="password" required autocomplete="new-password" aria-describedby="pw-rule"></label>
    <small v-if="stage==='change'" id="pw-rule">至少 8 个字符，包含英文字母和数字。</small>
    <button :disabled="busy">{{ stage==='login'?'登录':'保存新密码' }}</button>
    <button v-if="stage==='change'" type="button" :disabled="busy" @click="submit('logout')">退出</button>
  </form>
  <template v-else-if="profile">
    <div class="identity"><span>{{ profile.display_name }}</span><button :disabled="busy" @click="submit('logout')">退出登录</button></div>
    <p v-if="props.admin && !profile.roles.some(r=>r==='reviewer'||r==='tech_admin')" role="alert">当前账号无后台权限。</p>
    <slot v-else :key="profile.account_id" :profile="profile" :restore="restore" />
  </template>
  <p v-if="message" role="alert">{{ message }}</p>
</template>
<style scoped>
.credentials { max-width: 24rem; margin: 2rem auto; display:grid; gap:1rem; }
label { display:grid; gap:.35rem; }
input, button { font:inherit; border:1px solid #a8b6cc; border-radius:6px; padding:.55rem .8rem; }
.credentials button { background:#003399; color:white; cursor:pointer; }
.identity { display:flex; justify-content:flex-end; gap:1rem; align-items:center; padding:.75rem 1rem; }
.identity button { background:white; cursor:pointer; }
[role=alert] { color:#963622; }
</style>
