<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { ApiError, createCommand, removeActivityMember, type Activity, type ActivityMemberList } from '@hongyan/contracts';

const props = defineProps<{ activity: Activity; team: ActivityMemberList; canManage: boolean; paused: boolean }>();
const emit = defineEmits<{ saved: [string, ActivityMemberList]; refresh: [] }>();
type Member = ActivityMemberList['items'][number];
const dialog = ref<HTMLDialogElement>();
const selected = ref<Member>();
const version = ref(0), reason = ref(''), notice = ref(''), failure = ref(''), saving = ref(false);
const command = createCommand();

async function open(member: Member) {
  selected.value = member;
  version.value = props.team.version;
  reason.value = failure.value = notice.value = '';
  await nextTick();
  dialog.value?.showModal();
}

async function remove() {
  const member = selected.value;
  if (!member || !props.canManage || props.paused || saving.value || !reason.value.trim()) return;
  const id = props.activity.id;
  const body = { expected_version: version.value, reason: reason.value.trim() };
  saving.value = true;
  failure.value = '';
  try {
    const { data } = await removeActivityMember({ path: { id, account_id: member.account_id }, body,
      headers: command.headers('remove_activity_member', member.account_id, body), throwOnError: true });
    command.confirmed();
    dialog.value?.close();
    emit('saved', id, data.data);
    notice.value = '已从本活动移除' + member.display_name;
  } catch (e) {
    if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status ?? 0)) {
      dialog.value?.close();
      notice.value = e.status === 409 ? '团队已变化，请重新核对成员后操作' : e.message;
      emit('refresh');
    } else failure.value = e instanceof ApiError ? e.message : '移除结果未确认，请重试';
  } finally { saving.value = false; }
}
</script>

<template>
  <div class="scroll-table">
    <table aria-label="活动成员">
      <thead><tr><th scope="col">姓名</th><th scope="col">活动角色</th><th scope="col">学号</th><th v-if="canManage" scope="col">操作</th></tr></thead>
      <tbody><tr v-for="member in team.items" :key="member.account_id">
        <th scope="row">{{ member.display_name }}</th>
        <td>{{ member.member_role === 'owner' ? '主负责人' : '协作者' }}</td>
        <td>{{ member.student_no ?? '—' }}</td>
        <td v-if="canManage"><button v-if="member.member_role === 'collaborator'" class="remove" :disabled="paused"
          :aria-label="'移除协作者 ' + member.display_name" @click="open(member)">移除协作者</button></td>
      </tr></tbody>
    </table>
  </div>
  <p v-if="notice" role="status">{{ notice }}</p>
  <dialog ref="dialog" aria-labelledby="remove-title" @cancel="saving && $event.preventDefault()">
    <form v-if="selected" @submit.prevent="remove">
      <h3 id="remove-title">移除协作者</h3>
      <p>从「{{ activity.title }}」移除 <strong>{{ selected.display_name }}</strong><span v-if="selected.student_no">（{{ selected.student_no }}）</span>？</p>
      <p>移除后，对方将无法从负责人工作区查看本活动的报名名单和现场记录。学生身份及其他活动权限保留</p>
      <label>移除原因<input v-model="reason" required maxlength="2000" :disabled="saving" /></label>
      <p v-if="failure" role="alert">{{ failure }}</p>
      <div class="actions">
        <button type="button" :disabled="saving" @click="dialog?.close()">取消</button>
        <button class="confirm" :disabled="paused || saving || !reason.trim()">{{ saving ? '正在移除…' : '确认移除' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.remove { color:var(--danger); }
dialog { max-width:min(28rem, 90vw); border:1px solid var(--line); border-radius:var(--radius); padding:20px; }
dialog::backdrop { background:#17243a55; }
h3 { margin-top:0; }
label { display:grid; gap:6px; }
.actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
.confirm { background:var(--danger); color:white; }
</style>
