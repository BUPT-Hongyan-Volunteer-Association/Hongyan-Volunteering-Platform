<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError, createCommand, setAccountStatus, updateStudent, type AccountStatusPatch, type AccountSummary } from '@hongyan/contracts';

const props = defineProps<{ account: AccountSummary; self: boolean }>();
const emit = defineEmits<{ saved: [AccountSummary]; studentSaved: [string, AccountSummary['status']]; reload: [] }>();
const disabling = computed(() => props.account.status === 'active');
const action = computed(() => disabling.value ? '停用' : '启用');
const editing = ref(false), reason = ref(''), error = ref(''), stale = ref(false), busy = ref(false);
const verified = ref(false);
const needsVerification = computed(() => !!props.account.student_id && !disabling.value);
const command = createCommand();

function open() {
  reason.value = error.value = '';
  verified.value = false;
  editing.value = true;
}
async function submit() {
  if (busy.value || stale.value || !reason.value.trim() || (needsVerification.value && !verified.value)) return;
  const id = props.account.account_id;
  const body: AccountStatusPatch = {
    expected_version: props.account.version, status: disabling.value ? 'inactive' : 'active', reason: reason.value.trim(),
  };
  busy.value = true;
  error.value = '';
  try {
    const studentId = props.account.student_id;
    if (studentId) {
      const version = props.account.student_version;
      if (version === undefined) { stale.value = true; error.value = '请重新读取学生档案版本'; return; }
      const patch = { ...body, expected_version: version, ...(needsVerification.value && { pilot_scope_verified: verified.value }) };
      const { data } = await updateStudent({ path: { id: studentId }, body: patch,
        headers: command.headers('update_student', studentId, patch), throwOnError: true });
      command.confirmed();
      emit('studentSaved', id, data.data.status);
    } else {
      const { data } = await setAccountStatus({ path: { id }, body,
        headers: command.headers('set_account_status', id, body), throwOnError: true });
      command.confirmed();
      emit('saved', data.data);
    }
  } catch (e) {
    stale.value = e instanceof ApiError && (e.body?.code === 'version_conflict' || e.status === 403 || e.status === 404);
    error.value = e instanceof ApiError ? e.message : '操作结果未确认，请重试';
  } finally { busy.value = false; }
}
</script>

<template>
  <button v-if="!editing" @click="open">{{ action }}账号</button>
  <form v-else class="status-form" @submit.prevent="submit">
    <fieldset class="form-section" :disabled="stale || busy">
      <legend>{{ action }}账号 · {{ account.display_name }}（{{ account.username }}）</legend>
      <p v-if="disabling">{{ self ? '你当前的会话也将退出。' : '' }}停用将撤销该账号的全部登录会话，角色和历史记录保留</p>
      <p v-else>{{ account.credential_pending ? '该账号仍待发放登录凭证，启用后暂不可登录' : '启用后需重新登录，原来的会话继续失效' }}</p>
      <p v-if="disabling">若其担任主负责人，请到「活动团队」筛选待接管活动，重新指定主负责人。重新启用后，如负责人资格仍有效，可按届时保留的成员身份继续参与活动</p>
      <label v-if="needsVerification" class="verify"><input v-model="verified" type="checkbox" required />已核实该学生仍在学院核定试点范围内</label>
      <label>办理原因<textarea v-model="reason" required rows="2" :maxlength="account.student_id ? 500 : 2000" /></label>
      <div class="page-actions">
        <button class="primary" :disabled="!reason.trim() || (needsVerification && !verified)">{{ busy ? '正在办理…' : '确认' + action }}</button>
        <button type="button" @click="editing = false">取消</button>
      </div>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="stale" type="button" @click="emit('reload')">重新核对账号</button>
  </form>
</template>

<style scoped>
legend { font-weight:600; overflow-wrap:anywhere; }
p { margin:0; }
label { display:grid; gap:8px; }
.verify { display:flex; align-items:center; gap:8px; }
textarea { min-width:0; }
</style>
