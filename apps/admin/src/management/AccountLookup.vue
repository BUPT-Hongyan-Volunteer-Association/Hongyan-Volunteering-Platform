<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, getAccount, getAccountRoles, listAccounts, type AccountSummary, type AccountRoles, type Profile, type RoleGrant } from '@hongyan/contracts';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import OrganizerGrantForm from './OrganizerGrantForm.vue';

import StaffAccountForm from './StaffAccountForm.vue';

const props = defineProps<{ profile: Profile }>();
const technical = computed(() => props.profile.roles.includes('tech_admin'));
const route = useRoute();
const number = ref('');
const account = ref<AccountSummary>();
const roleState = ref<AccountRoles>();
const now = ref(Date.now());
const clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
onUnmounted(() => { clearInterval(clock); serial++; });
const busy = ref(false);
const message = ref('');
const labels = { student: '学生', organizer: '负责人', reviewer: '老师审核员', tech_admin: '技术管理员' };
const detailId = computed(() => String(route.params.item ?? ''));
let serial = 0;

function reset() {
  serial++;
  account.value = undefined;
  roleState.value = undefined;
  message.value = '';
  busy.value = false;
}

async function lookup() {
  reset();
  const username = number.value.trim();
  if (!detailId.value && (!username || (!technical.value && !/^\d{10}$/.test(username)))) {
    message.value = technical.value ? '请输入完整登录账号。' : '请输入完整的十位学号，保留开头的 0。';
    return;
  }
  const current = serial;
  busy.value = true;
  try {
    const match = detailId.value
      ? (await getAccount({ path: { id: detailId.value }, throwOnError: true })).data.data
      : (await listAccounts({ query: { ...(technical.value ? { username } : { q: username }), page_size: 1 }, throwOnError: true })).data.data.items[0];
    if (serial !== current) return;
    const roles = match && (await getAccountRoles({ path: { id:match.account_id }, throwOnError:true })).data.data;
    if (serial !== current) return;
    roleState.value = roles;
    account.value = match;
    if (!match) message.value = technical.value ? '没有找到匹配的登录账号。' : '没有找到可查看的账号，请核对学号。';
  } catch (error) {
    if (serial !== current) return;
    message.value = error instanceof ApiError && [403, 404].includes(error.status ?? 0)
      ? '没有找到可查看的账号。' : '查询未完成，请重试。';
  } finally {
    if (serial === current) busy.value = false;
  }
}

watch([detailId, () => props.profile.account_id, technical], ([id]) => {
  reset();
  number.value = '';
  if (id) void lookup();
}, { immediate: true });

function validity(grant: RoleGrant) {
  if (!grant.expires_at) return '长期有效';
  return (Date.parse(grant.expires_at) <= now.value ? '已到期 · ' : '有效至 ') + localDateTime(grant.expires_at) + '（北京时间）';
}

function saved(roles: AccountRoles, notice: string) {
  if (account.value?.account_id !== roles.account_id) return;
  roleState.value = roles;
  message.value = notice;
}
</script>

<template>
  <section class="lookup">
    <RouterLink v-if="detailId" class="back-link" to="/manage/accounts">返回账号查询</RouterLink>
    <div class="page-heading"><h1>账号与角色</h1></div>
    <form v-if="!detailId" class="lookup-form" novalidate @submit.prevent="lookup">
      <label for="student-lookup">{{ technical ? '登录账号' : '学生学号' }}</label>
      <p id="lookup-hint">{{ technical ? '可输入后台登录账号或十位学号。' : '按完整十位学号查找，同名学生以学号区分。' }}</p>
      <div class="entry">
        <input id="student-lookup" v-model="number" :inputmode="technical ? 'text' : 'numeric'" autocomplete="off"
          aria-describedby="lookup-hint" :placeholder="technical ? '输入完整登录账号' : '输入十位学号'" @input="reset" />
        <button class="primary" :disabled="busy">{{ busy ? '正在查询…' : '查询账号' }}</button>
      </div>
    </form>
    <StaffAccountForm v-if="technical && !detailId" />
    <RouterLink v-if="!technical && !detailId" class="onboard" to="/manage/imports">导入学生名单建档</RouterLink>
    <p role="status">{{ message || (account ? '已找到可查看的账号' : '') }}</p>
    <button v-if="detailId && message" @click="lookup">重新读取</button>
    <section v-if="account && roleState" class="identity-card" aria-label="账号核对结果">
      <header class="section-heading"><h2>{{ account.display_name }}</h2><span class="state-chip">{{ account.status === 'active' ? '启用' : '停用' }}</span></header>
      <dl>
        <dt>{{ account.student_id ? '学号' : '登录账号' }}</dt><dd>{{ account.username }}</dd>
        <template v-if="account.credential_pending"><dt>初始凭证</dt><dd>待发放，暂不可登录</dd></template>
        <dt>角色与有效期</dt>
        <dd><ul><li v-for="grant in roleState.roles" :key="grant.role"><strong>{{ labels[grant.role] }}</strong> · {{ validity(grant) }}</li></ul>
          <span v-if="!roleState.roles.length">无角色</span></dd>
      </dl>
      <p v-if="account.student_id">具备负责人资格不等于已加入某个活动。</p>
      <OrganizerGrantForm v-if="account.student_id && roleState.roles.some(g => g.role === 'student')
        && !roleState.roles.some(g => g.role === 'reviewer' || g.role === 'tech_admin')"
        :key="account.account_id" :account="account" :state="roleState" :now="now"
        @saved="saved" @reload="lookup" />
    </section>
  </section>
</template>

<style scoped>
.onboard { display:inline-block; margin-top:12px; }
.lookup { max-width: 48rem; }
.lookup-form,.identity-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:clamp(14px,3vw,24px); }
.lookup-form label { font-weight:600; }
.lookup-form p,.identity-card p { color:var(--muted); font-size:14px; }
.entry { display:flex; flex-wrap:wrap; gap:10px; }
.entry input { flex:1 1 14rem; min-width:0; }
.identity-card dl { display:grid; grid-template-columns:auto 1fr; gap:12px 18px; }
.identity-card dt { color:var(--muted); }
.identity-card dd { margin:0; overflow-wrap:anywhere; }
.identity-card ul { list-style:none; margin:0; padding:0; }
.identity-card p { border-top:1px solid var(--line); padding-top:12px; margin-bottom:0; }
</style>
