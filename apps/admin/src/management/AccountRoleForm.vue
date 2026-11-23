<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError, createCommand, setAccountRoles, type AccountRoles, type AccountSummary, type RoleReplacement } from '@hongyan/contracts';

const props = defineProps<{ account: AccountSummary; state: AccountRoles; now: number; role: 'organizer' | 'reviewer' | 'tech_admin' }>();
const emit = defineEmits<{ saved: [AccountRoles, string]; reload: [] }>();
const command = createCommand();
const editing = ref<'grant' | 'remove'>();
const term = ref<'permanent' | 'limited'>('permanent'), end = ref(''), reason = ref('');
const busy = ref(false), stale = ref(false), error = ref('');
const roleNames = { organizer: '负责人资格', reviewer: '老师审核员角色', tech_admin: '技术管理员角色' };
const title = computed(() => roleNames[props.role]);
const description = {
  organizer: '负责人资格允许在已分配的活动中工作，活动成员关系单独维护。',
  reviewer: '老师审核员可进入审核后台，办理学生授权、审核等业务。',
  tech_admin: '技术管理员可管理高权限账号、角色和登录凭证。',
};
const grant = computed(() => props.state.roles.find(grant => grant.role === props.role));
const active = computed(() => !!grant.value && (!grant.value.expires_at || Date.parse(grant.value.expires_at) > props.now));

function open(action: 'grant' | 'remove') {
  const expiry = active.value && grant.value?.expires_at;
  editing.value = action;
  term.value = expiry ? 'limited' : 'permanent';
  end.value = expiry ? new Date(Date.parse(expiry) + 8 * 3600000).toISOString().slice(0, 16) : '';
  reason.value = '';
  error.value = '';
}

async function submit() {
  if (!editing.value || busy.value || stale.value) return;
  const removing = editing.value === 'remove';
  const body: RoleReplacement = { expected_version: props.state.version,
    reason: reason.value.trim(), roles: props.state.roles.filter(grant => grant.role !== props.role) };
  if (!body.reason) { error.value = '请填写办理原因。'; return; }
  if (!removing) {
    const expiry = term.value === 'limited' ? Date.parse(end.value + '+08:00') : undefined;
    if (expiry !== undefined && !(expiry > Date.now())) { error.value = '请选择未来的北京时间。'; return; }
    body.roles.push({ role: props.role, ...(expiry !== undefined && { expires_at: new Date(expiry).toISOString() }) });
  }
  busy.value = true;
  error.value = '';
  try {
    const { data } = await setAccountRoles({ path: { id: props.account.account_id }, body,
      headers: command.headers('set_account_roles', props.account.account_id, body), throwOnError: true });
    command.confirmed();
    editing.value = undefined;
    emit('saved', data.data, props.role === 'organizer' && props.account.student_id
      ? (removing ? '已收回负责人资格，学生身份保留。' : '负责人资格已保存，本次操作不会分配活动。')
      : title.value + (removing ? '已收回。' : '已保存。'));
  } catch (failure) {
    stale.value = failure instanceof ApiError && (failure.status === 403 || failure.status === 404 || failure.body?.code === 'version_conflict');
    error.value = stale.value ? '资料或权限已变化，请重新核对后再办理。'
      : failure instanceof ApiError && failure.status ? failure.message : '结果未确认，可用相同内容重试。';
  } finally { busy.value = false; }
}
</script>

<template>
  <div v-if="!editing" class="page-actions">
    <button class="primary" @click="open('grant')">{{ active ? '调整有效期' : '授予' + title }}</button>
    <button v-if="active" @click="open('remove')">收回{{ title }}</button>
  </div>
  <form v-else class="grant-form" @submit.prevent="submit">
    <fieldset :disabled="busy || stale">
      <legend>{{ (editing === 'remove' ? '收回' : '设置') + title }} · {{ account.display_name }}（{{ account.username }}）</legend>
      <p v-if="editing === 'grant'">{{ description[role] }}</p>
      <template v-if="editing === 'grant'">
        <div class="terms"><label><input v-model="term" type="radio" value="permanent" />长期授权</label>
          <label><input v-model="term" type="radio" value="limited" />限期授权</label></div>
        <small v-if="term === 'permanent'">长期授权没有到期日。要设置结束时间，请选择「限期授权」。</small>
        <label v-if="term === 'limited'">到期时间（北京时间）<input v-model="end" type="datetime-local" required /></label>
      </template>
      <p v-else-if="role === 'organizer' && account.student_id">收回后，该账号将失去负责人管理权限，学生身份和历史记录保留。</p>
      <p v-else>收回后，此角色的授权将在下一次请求时失效，其他角色和历史记录保留。</p>
      <label>办理原因<textarea v-model="reason" rows="2" maxlength="2000" required /></label>
      <div class="page-actions">
        <button class="primary" :disabled="busy">{{ busy ? '正在办理…' : editing === 'remove' ? (role === 'organizer' ? '确认收回资格' : '确认收回' + title) : '保存' + title }}</button>
        <button type="button" @click="editing = undefined">取消</button>
      </div>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="stale" type="button" @click="emit('reload')">重新核对</button>
  </form>
</template>

<style scoped>
.grant-form fieldset { min-width:0; border:1px solid var(--line); border-radius:var(--radius); padding:16px; display:grid; gap:12px; }
.grant-form legend { font-weight:600; overflow-wrap:anywhere; }
.grant-form label { display:grid; gap:6px; }
.grant-form textarea,.grant-form input[type=datetime-local] { min-width:0; max-width:100%; box-sizing:border-box; }
.terms { display:flex; gap:18px; flex-wrap:wrap; }
.terms label { display:flex; align-items:center; gap:4px; }
</style>
