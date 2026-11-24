<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, getAccount, listAccounts, type AccountSummary, type AccountRoles, type Profile, type RoleGrant } from '@hongyan/contracts';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import AccountDirectory from './AccountDirectory.vue';
import AccountRoleForm from './AccountRoleForm.vue';

import CredentialResetForm from './CredentialResetForm.vue';
import AccountStatusForm from './AccountStatusForm.vue';
import StaffAccountForm from './StaffAccountForm.vue';

const props = defineProps<{ profile: Profile }>();
const technical = computed(() => props.profile.roles.includes('tech_admin'));
const route = useRoute();
const number = ref('');
const managedRole = ref<'organizer' | 'reviewer' | 'tech_admin'>('organizer');
const account = ref<AccountSummary>();
const directoryRevision = ref(0);
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
  managedRole.value = 'organizer';
  message.value = '';
  busy.value = false;
}

const studentsReturn = computed(() => {
  const path = route.query.students;
  return typeof path === 'string' && /^\/manage\/students(?:\?|$)/.test(path) ? path : undefined;
});

async function lookup(notice = '') {
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
    account.value = match;
    if (technical.value && match) {
      const assigned = match.roles.map(grant => grant.role);
      if (assigned.includes('tech_admin')) managedRole.value = 'tech_admin';
      else if (assigned.includes('reviewer')) managedRole.value = 'reviewer';
    }
    if (match) message.value = notice;
    else message.value = technical.value ? '没有找到匹配的登录账号。' : '没有找到可查看的账号，请核对学号。';
  } catch (error) {
    if (serial !== current) return;
    message.value = notice + (error instanceof ApiError && [403, 404].includes(error.status ?? 0)
      ? '没有找到可查看的账号。' : '查询未完成，请重试。');
  } finally {
    if (serial === current) busy.value = false;
  }
}

watch([detailId, () => props.profile.account_id, technical], ([id]) => {
  reset();
  number.value = '';
  if (id) void lookup();
}, { immediate: true });

function studentStatusSaved(id: string, status: 'active' | 'inactive') {
  if (account.value?.account_id !== id) return;
  if (id === props.profile.account_id && status === 'inactive') {
    window.dispatchEvent(new Event('hongyan-session-expired'));
    return;
  }
  const notice = status === 'active' ? '学生账号已恢复启用，原会话仍然失效。' : '学生账号已停用，所有旧会话已撤销。';
  void lookup(notice);
}

function statusSaved(next: AccountSummary) {
  if (account.value?.account_id !== next.account_id || account.value.version > next.version) return;
  const current = account.value;
  account.value = current.roles_version > next.roles_version
    ? { ...next, roles_version: current.roles_version, roles: current.roles } : next;
  message.value = next.status === 'active' ? '账号已启用。' : '账号已停用，所有旧会话已撤销。';
  if (next.account_id === props.profile.account_id && next.status === 'inactive')
    window.dispatchEvent(new Event('hongyan-session-expired'));
}

function credentialChanged(next: AccountSummary) {
  if (account.value?.account_id !== next.account_id || account.value.version > next.version) return;
  account.value = { ...account.value, version: next.version, credential_pending: next.credential_pending };
  message.value = next.credential_pending ? '旧凭证和登录会话已失效，新凭证待发放。' : '临时凭证已签发，首次登录须修改密码。';
  if (next.account_id === props.profile.account_id) window.dispatchEvent(new Event('hongyan-session-expired'));
}

function validity(grant: RoleGrant) {
  if (!grant.expires_at) return '长期有效';
  return (Date.parse(grant.expires_at) <= now.value ? '已到期 · ' : '有效至 ') + localDateTime(grant.expires_at) + '（北京时间）';
}

function saved(roles: AccountRoles, notice: string) {
  if (account.value?.account_id !== roles.account_id || account.value.roles_version > roles.version) return;
  account.value = { ...account.value, roles: roles.roles, roles_version: roles.version };
  message.value = notice;
  if (roles.account_id === props.profile.account_id) window.dispatchEvent(new Event('hongyan-roles-changed'));
}
</script>

<template>
  <section class="lookup">
    <RouterLink v-if="detailId" class="back-link" :to="studentsReturn ?? '/manage/accounts'">{{ studentsReturn ? '返回学生档案' : '返回账号查询' }}</RouterLink>
    <div class="page-heading"><h1>账号与角色</h1></div>
    <form v-if="!detailId" class="lookup-form" novalidate @submit.prevent="lookup()">
      <label for="student-lookup">{{ technical ? '登录账号' : '学生学号' }}</label>
      <p id="lookup-hint">{{ technical ? '可输入后台登录账号或十位学号。' : '按完整十位学号查找，同名学生以学号区分。' }}</p>
      <div class="entry">
        <input id="student-lookup" v-model="number" :inputmode="technical ? 'text' : 'numeric'" autocomplete="off"
          aria-describedby="lookup-hint" :placeholder="technical ? '输入完整登录账号' : '输入十位学号'" @input="reset" />
        <button class="primary" :disabled="busy">{{ busy ? '正在查询…' : '查询账号' }}</button>
      </div>
    </form>
    <StaffAccountForm v-if="technical && !detailId" @created="directoryRevision++" />
    <AccountDirectory :key="directoryRevision" v-if="technical && !detailId && !account" />
    <RouterLink v-if="!technical && !detailId" class="onboard" to="/manage/imports">导入学生名单建档</RouterLink>
    <p role="status">{{ message || (account ? '已找到可查看的账号' : '') }}</p>
    <button v-if="detailId && message" @click="lookup()">重新读取</button>
    <section v-if="account" class="identity-card" aria-label="账号核对结果">
      <header class="section-heading"><h2>{{ account.display_name }}</h2><span class="state-chip">{{ account.status === 'active' ? '启用' : '停用' }}</span></header>
      <dl>
        <dt>{{ account.student_id ? '学号' : '登录账号' }}</dt><dd>{{ account.username }}</dd>
        <template v-if="account.credential_pending"><dt>登录凭证</dt><dd>待发放，暂不可登录</dd></template>
        <dt>角色与有效期</dt>
        <dd><ul><li v-for="grant in account.roles" :key="grant.role"><strong>{{ labels[grant.role] }}</strong> · {{ validity(grant) }}</li></ul>
          <span v-if="!account.roles.length">无角色</span></dd>
      </dl>
      <p v-if="account.student_id">具备负责人资格不等于已加入某个活动。</p>
      <label v-if="technical" class="role-choice">要办理的角色
        <select v-model="managedRole"><option value="organizer">负责人</option><option value="reviewer">老师审核员</option><option value="tech_admin">技术管理员</option></select>
      </label>
      <AccountRoleForm v-if="technical || (account.student_id && account.roles.some(g => g.role === 'student')
        && !account.roles.some(g => g.role === 'reviewer' || g.role === 'tech_admin'))"
        :key="[account.account_id, account.roles_version, managedRole].join('/')" :role="technical ? managedRole : 'organizer'"
        :account="account" :now="now"
        @saved="saved" @reload="lookup" />
      <details :key="account.account_id + ':' + account.version" class="account-security">
        <summary>账号安全</summary>
        <div class="page-actions">
          <CredentialResetForm :account="account" :self="account.account_id === profile.account_id"
            @saved="credentialChanged" @reload="lookup" />
          <AccountStatusForm v-if="technical || account.student_id" :account="account" :self="account.account_id === profile.account_id"
            @saved="statusSaved" @student-saved="studentStatusSaved" @reload="lookup" />
        </div>
      </details>
    </section>
  </section>
</template>

<style scoped>
.onboard { display:inline-block; margin-top:12px; }
.role-choice { display:grid; gap:6px; max-width:20rem; margin:16px 0 8px; }
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
.identity-card > p { border-top:1px solid var(--line); padding-top:12px; margin-bottom:12px; }
.account-security { margin-top:16px; border-top:1px solid var(--line); }
.account-security summary { padding:12px 0; color:var(--ink); }
.account-security .page-actions > :deep(form) { flex-basis:100%; min-width:0; }
</style>
