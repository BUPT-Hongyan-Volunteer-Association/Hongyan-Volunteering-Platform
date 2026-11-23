<script setup lang="ts">
import { ref } from 'vue';
import { ApiError, createCommand, createStaffAccount, type StaffAccountInput } from '@hongyan/contracts';

const username = ref(''), name = ref(''), reason = ref('');
const role = ref<StaffAccountInput['role']>('reviewer');
const review = ref<StaffAccountInput>(), created = ref<{ id: string; username: string }>();
const busy = ref(false), message = ref('');
const command = createCommand();
const labels = { reviewer: '老师审核员', tech_admin: '技术管理员' };

function check() {
  const input = { username: username.value.trim(), display_name: name.value.trim(), role: role.value, reason: reason.value.trim() };
  if (!input.username || !input.display_name || !input.reason) {
    message.value = '请填写登录账号、姓名及创建原因。';
    return;
  }
  message.value = '';
  review.value = input;
}
async function submit() {
  if (busy.value || !review.value) return;
  const body = review.value;
  busy.value = true;
  message.value = '';
  try {
    const { data } = await createStaffAccount({ body, headers: command.headers('create_staff_account', body.username, body), throwOnError: true });
    command.confirmed();
    created.value = { id: data.data.account_id, username: body.username };
    review.value = undefined;
    username.value = name.value = reason.value = '';
    role.value = 'reviewer';
  } catch (e) {
    message.value = e instanceof ApiError ? e.message : '结果未确认，请用相同内容重试。';
    if (e instanceof ApiError && e.status === 409) review.value = undefined;
  } finally { busy.value = false; }
}
</script>

<template>
  <details class="create">
    <summary>创建后台账号</summary>
    <div v-if="created">
      <p role="status">已创建 {{ created.username }}，待发放初始凭证。</p>
      <RouterLink :to="'/manage/accounts/' + created.id">查看新账号详情</RouterLink>
      <button type="button" @click="created = undefined">继续创建</button>
    </div>
    <form v-else-if="!review" @submit.prevent="check">
      <label>新账号登录名<input v-model="username" required maxlength="64" autocomplete="off" /></label>
      <label>姓名<input v-model="name" required maxlength="100" /></label>
      <label>后台角色<select v-model="role"><option value="reviewer">老师审核员</option><option value="tech_admin">技术管理员</option></select></label>
      <label>创建原因<textarea v-model="reason" required maxlength="2000" rows="2" /></label>
      <button>核对创建信息</button>
    </form>
    <form v-else @submit.prevent="submit">
      <h2>核对后台账号</h2>
      <dl><dt>登录账号</dt><dd>{{ review.username }}</dd><dt>姓名</dt><dd>{{ review.display_name }}</dd>
        <dt>后台角色</dt><dd>{{ labels[review.role] }}</dd><dt>创建原因</dt><dd>{{ review.reason }}</dd></dl>
      <p>初始凭证须独立发放，发放前该账号无法登录。</p>
      <div><button type="button" :disabled="busy" @click="review = undefined">返回修改</button>
        <button class="primary" :disabled="busy">{{ busy ? '正在创建…' : '确认创建' }}</button></div>
    </form>
    <p v-if="message" role="alert">{{ message }}</p>
  </details>
</template>

<style scoped>
.create { margin-top:16px; padding:16px; border:1px solid var(--line); border-radius:var(--radius); }
summary { color:var(--brand); font-weight:600; cursor:pointer; }
form, label { display:grid; gap:6px; }
form { gap:12px; margin-top:16px; }
h2, p, dl { margin:8px 0; }
dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; }
dt { color:var(--muted); }
dd { margin:0; overflow-wrap:anywhere; }
button { justify-self:start; }
</style>
