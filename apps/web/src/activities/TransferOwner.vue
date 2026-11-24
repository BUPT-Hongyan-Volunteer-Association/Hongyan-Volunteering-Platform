<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError, createCommand, transferActivityOwner, type Activity, type ActivityMemberList } from '@hongyan/contracts';

const props = defineProps<{ activity: Activity; team: ActivityMemberList; paused: boolean }>();
const emit = defineEmits<{ target: [accountId: string]; saved: [string, ActivityMemberList]; refresh: [] }>();
const collaborators = computed(() => props.team.items.filter(person => person.member_role === 'collaborator'));
const target = ref(''), reason = ref(''), notice = ref(''), saving = ref(false);
const selected = computed(() => collaborators.value.find(person => person.account_id === target.value));
const retrying = ref(false);
const command = createCommand();

async function submit() {
  if (saving.value || props.paused || !selected.value || !reason.value.trim()) return;
  const id = props.activity.id;
  const body = { expected_version: props.team.version, target_account_id: target.value, reason: reason.value.trim() };
  emit('target', body.target_account_id);
  notice.value = '';
  saving.value = true;
  try {
    const { data } = await transferActivityOwner({ path: { id }, body,
      headers: command.headers('transfer_activity_owner', id, body), throwOnError: true });
    command.confirmed();
    emit('saved', id, data.data);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : undefined;
    retrying.value = !status || status >= 500;
    if (retrying.value) {
      notice.value = '交接结果未确认。点击「重试交接」将使用原请求核对结果。';
    } else {
      if (status !== 404 && status !== 409) emit('target', '');
      notice.value = status === 404 ? '交接请求未获确认，请核对最新成员名单中的主负责人。'
        : error instanceof Error ? error.message : '交接失败。';
      if (status && [401, 403, 404, 409].includes(status)) emit('refresh');
    }
  } finally { saving.value = false; }
}
</script>

<template>
  <details>
    <summary>交接主负责人</summary>
    <p v-if="!collaborators.length">请先添加一位协作者，再办理交接。</p>
    <form v-else @submit.prevent="submit">
      <label>接任协作者<select v-model="target" required :disabled="saving || retrying">
        <option disabled value="">请选择协作者</option>
        <option v-for="person in collaborators" :key="person.account_id" :value="person.account_id">{{ person.display_name }} · {{ person.student_no }}</option>
      </select></label>
      <template v-if="selected">
        <p>{{ selected.display_name }} 将成为「{{ activity.title }}」的主负责人。你将保留协作者身份，成员管理权限将移交给对方。</p>
        <label>交接原因<input v-model="reason" required maxlength="500" :disabled="saving || retrying" /></label>
        <button class="primary" :disabled="paused || saving || !reason.trim()">{{ saving ? '正在交接…' : retrying ? '重试交接' : '确认交接' }}</button>
      </template>
      <p v-if="notice" role="alert">{{ notice }}</p>
    </form>
  </details>
</template>

<style scoped>
details { margin-top:16px; padding:16px; border:1px solid var(--line); border-radius:var(--radius); }
summary { color:var(--brand); font-weight:600; cursor:pointer; }
form, label { display:grid; gap:8px; }
form { max-width:36rem; margin-top:12px; }
button { justify-self:start; }
</style>
