<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ApiError, createCommand, findActivityMemberCandidate, setActivityMembers,
  type Activity, type ActivityMemberCandidate, type ActivityMemberList } from '@hongyan/contracts';

const props = defineProps<{ activity: Activity; team: ActivityMemberList }>();
const emit = defineEmits<{ saved: [string, ActivityMemberList, string]; refresh: [string] }>();
const number = ref(''), reason = ref(''), message = ref('');
const match = ref<ActivityMemberCandidate>(), looking = ref(false), saving = ref(false);
const member = computed(() => props.team.items.find(m => m.account_id === match.value?.account_id));
const command = createCommand();
let serial = 0;
function clear() {
  serial++;
  match.value = undefined;
  looking.value = false;
  reason.value = message.value = '';
}
onUnmounted(() => { serial++; });
async function lookup() {
  clear();
  const turn = serial;
  if (!/^[0-9]{10}$/.test(number.value)) { message.value = '请输入完整十位学号。'; return; }
  looking.value = true;
  try {
    const { data } = await findActivityMemberCandidate({ path: { id: props.activity.id },
      query: { student_no: number.value }, throwOnError: true });
    if (turn !== serial) return;
    match.value = data.data.items[0];
    if (!match.value) message.value = '未找到具有有效负责人资格的学生。';
  } catch (e) { if (turn === serial) message.value = e instanceof Error ? e.message : '核对失败，请重试'; }
  finally { if (turn === serial) looking.value = false; }
}
async function submit() {
  if (!match.value || saving.value || member.value?.member_role === 'owner' || !reason.value.trim()) return;
  const turn = serial, id = props.activity.id, target = match.value.account_id, name = match.value.display_name;
  const transfer = member.value?.member_role === 'collaborator';
  const members = props.team.items.map(({ account_id, member_role }) => ({ account_id, member_role }));
  if (transfer) {
    for (const person of members) person.member_role = person.account_id === target ? 'owner' : 'collaborator';
  } else members.push({ account_id: target, member_role: 'collaborator' });
  const body = { require_unavailable_owner: true, expected_version: props.team.version, members, reason: reason.value.trim() };
  saving.value = true;
  try {
    const { data } = await setActivityMembers({ path: { id }, body, headers: command.headers('set_activity_members', id, body), throwOnError: true });
    if (turn !== serial) return;
    command.confirmed();
    reason.value = message.value = '';
    emit('saved', id, data.data, transfer ? name + '已接任主负责人。' : name + '已加入活动，请核对交接信息并填写交接原因。');
  } catch (e) {
    if (turn !== serial) return;
    if (e instanceof ApiError && e.status === 422) {
      message.value = e.message;
    } else if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status ?? 0)) {
      emit('refresh', e.status === 409 ? e.message + '，请重新核对后办理。' : e.message);
    } else message.value = '提交结果未确认，请重试。';
  } finally { saving.value = false; }
}
</script>

<template>
  <section class="repair">
    <h2>重新指定主负责人</h2>
    <form @submit.prevent="lookup">
      <label>接任人学号<input v-model="number" autocomplete="off" inputmode="numeric" :disabled="saving" @input="clear" /></label>
      <button :disabled="looking || saving">{{ looking ? '正在核对…' : '核对接任人' }}</button>
    </form>
    <div v-if="match" class="candidate">
      <strong>{{ match.display_name }} · {{ match.student_no }}</strong>
      <p v-if="member?.member_role === 'owner'">该学生已是主负责人，请刷新查看最新资格。</p>
      <form v-else @submit.prevent="submit">
        <p>{{ member ? '确认后，该协作者将接任主负责人，原主负责人保留为协作者。' : '该学生尚未加入本活动，请先添加为协作者。' }}</p>
        <label>{{ member ? '交接原因' : '添加原因' }}<input v-model="reason" required maxlength="500" :disabled="saving" /></label>
        <button class="primary" :disabled="saving || !reason.trim()">{{ saving ? '正在提交…' : member ? '确认重新指定' : '确认添加协作者' }}</button>
      </form>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.repair { padding:16px; border:1px solid var(--line); border-radius:var(--radius); }
h2 { margin:0 0 12px; font-size:1.15rem; }
form { display:flex; align-items:end; flex-wrap:wrap; gap:10px; }
label { display:grid; gap:6px; }
form p { flex-basis:100%; margin-bottom:0; }
.candidate { border-top:1px solid var(--line); margin-top:16px; padding-top:12px; }
</style>
