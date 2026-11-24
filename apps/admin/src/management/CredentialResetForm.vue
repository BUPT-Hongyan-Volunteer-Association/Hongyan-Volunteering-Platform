<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError, createCommand, resetPassword, type AccountSummary } from '@hongyan/contracts';

const props = defineProps<{ account: AccountSummary; self: boolean }>();
const emit = defineEmits<{ saved: [AccountSummary]; reload: [] }>();
const editing = ref(false), verified = ref(false), busy = ref(false), stale = ref(false);
const reason = ref(''), error = ref('');
const temporaryPassword = ref('');
const issuing = computed(() => props.account.credential_pending === true);
const action = computed(() => issuing.value ? '签发临时凭证' : '重置登录凭证');
const command = createCommand();
function open() {
  temporaryPassword.value = issuing.value ? 'T9' + crypto.randomUUID().replaceAll('-', '') : '';
  verified.value = false;
  reason.value = error.value = '';
  editing.value = true;
}
async function submit() {
  if (!verified.value || !reason.value.trim() || busy.value || stale.value) return;
  const account = props.account;
  const id = account.account_id;
  const body = { expected_version: account.version, reason: reason.value.trim(),
    ...(issuing.value && { temporary_password: temporaryPassword.value }) };
  busy.value = true;
  error.value = '';
  try {
    const { data } = await resetPassword({ path: { id }, body,
      headers: command.headers('reset_password', id, body), throwOnError: true });
    command.confirmed();
    emit('saved', { ...account, version: data.data.version ?? account.version + 1, credential_pending: !issuing.value });
  } catch (e) {
    stale.value = e instanceof ApiError && (e.body?.code === 'version_conflict' || e.status === 403 || e.status === 404);
    error.value = e instanceof ApiError ? e.message : '操作结果未确认，请重试。';
  } finally { busy.value = false; }
}
</script>

<template>
  <button v-if="!editing" @click="open">{{ action }}</button>
  <form v-else @submit.prevent="submit">
    <fieldset :disabled="busy || stale">
      <legend>{{ action }} · {{ account.display_name }}（{{ account.username }}）</legend>
      <template v-if="issuing">
        <label>临时凭证<input :value="temporaryPassword" readonly autocomplete="off" spellcheck="false" /></label>
        <p>请先复制临时凭证，确认签发成功后交给已核验的本人。首次登录时须设置新密码。</p>
      </template>
      <p v-else>确认后旧密码和所有登录会话立即失效，新凭证的发放渠道待学院确认。{{ self ? '你当前的会话也会退出。' : '' }}</p>
      <label class="check"><input v-model="verified" type="checkbox" required />我已人工核验申请人本人，并核对上述账号</label>
      <label>{{ issuing ? '签发原因' : '重置原因' }}<textarea v-model="reason" rows="2" maxlength="2000" required placeholder="填写办理原因，请勿录入密码或证件号码" /></label>
      <div class="page-actions">
        <button class="primary" :disabled="!verified || !reason.trim()">{{ busy ? '正在办理…' : issuing ? '确认签发' : '确认重置' }}</button>
        <button type="button" @click="editing = false; temporaryPassword = ''">取消</button>
      </div>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="stale" type="button" @click="emit('reload')">重新核对账号</button>
  </form>
</template>

<style scoped>
fieldset { min-width:0; display:grid; gap:12px; padding:16px; border:1px solid var(--line); border-radius:var(--radius); }
legend { font-weight:600; overflow-wrap:anywhere; }
p { margin:0; }
label { display:grid; gap:6px; }
.check { display:flex; align-items:center; gap:8px; }
textarea { min-width:0; }
</style>
