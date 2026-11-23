<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError, addActivityMember, createCommand, findActivityMemberCandidate,
  type Activity, type ActivityMemberCandidate, type ActivityMemberList } from '@hongyan/contracts';

const props = defineProps<{ activity: Activity; team: ActivityMemberList; paused: boolean }>();
const emit = defineEmits<{ saved: [string, ActivityMemberList]; refresh: [] }>();
const command = createCommand();
const number = ref(''), reason = ref(''), notice = ref('');
const candidate = ref<ActivityMemberCandidate>(), version = ref(0);
const looking = ref(false), saving = ref(false);
const member = computed(() => props.team.items.find(person => person.account_id === candidate.value?.account_id));
let serial = 0;

function clear() {
  serial++;
  looking.value = false;
  candidate.value = undefined;
  reason.value = '';
  notice.value = '';
}

function failure(error: unknown) {
  if (error instanceof ApiError && [401, 403, 404, 409, 422].includes(error.status ?? 0)) {
    clear();
    notice.value = error.status === 409 ? '团队已变化，请重新查找并核对。' : error.message;
    emit('refresh');
  } else notice.value = '请求结果未确认，请重试。';
}

async function find() {
  if (saving.value || props.paused) return;
  clear();
  if (!/^[0-9]{10}$/.test(number.value)) { notice.value = '请输入完整的十位学号。'; return; }
  const turn = serial;
  version.value = props.team.version;
  looking.value = true;
  try {
    const { data } = await findActivityMemberCandidate({ path: { id:props.activity.id },
      query:{ student_no:number.value }, throwOnError:true });
    if (turn !== serial) return;
    candidate.value = data.data.items[0];
    if (!candidate.value) notice.value = '未找到匹配的有效负责人，请核对学号或联系老师确认资格。';
  } catch (error) { if (turn === serial) failure(error); }
  finally { if (turn === serial) looking.value = false; }
}

async function add() {
  if (saving.value || props.paused || !candidate.value || member.value) return;
  const body = { account_id:candidate.value.account_id, reason:reason.value.trim(), expected_version:version.value };
  if (!body.reason) { notice.value = '请填写添加原因。'; return; }
  const id = props.activity.id;
  const name = candidate.value.display_name;
  saving.value = true;
  try {
    const { data } = await addActivityMember({path:{id},body,headers:command.headers('add_activity_member',id,body),throwOnError:true});
    command.confirmed();
    clear();
    number.value = '';
    emit('saved', id, data.data);
    notice.value = name + '已加入本活动，身份为协作者。';
  } catch (error) { failure(error); }
  finally { saving.value = false; }
}
</script>

<template>
  <details class="add-member">
    <summary>添加协作者</summary>
    <form @submit.prevent="find">
      <label>协作者学号<input v-model="number" inputmode="numeric" autocomplete="off" placeholder="完整十位学号"
        :disabled="saving" @input="clear" /></label>
      <button :disabled="looking || saving || paused">{{ looking ? '正在查找…' : '查找负责人' }}</button>
    </form>
    <section v-if="candidate" aria-label="候选人核对">
      <strong>{{ candidate.display_name }} · {{ candidate.student_no }}</strong>
      <p v-if="member">已是本活动{{ member.member_role === 'owner' ? '主负责人' : '协作者' }}，无需重复添加。</p>
      <form v-else @submit.prevent="add">
        <p>将加入「{{ activity.title }}」（{{ activity.activity_code }}），仅获得本活动的协作权限。</p>
        <label>添加原因<input v-model="reason" required maxlength="2000" :disabled="saving" /></label>
        <button class="primary" :disabled="saving || paused">{{ saving ? '正在添加…' : '确认添加协作者' }}</button>
      </form>
    </section>
    <p v-if="notice" role="status">{{ notice }}</p>
  </details>
</template>

<style scoped>
.add-member { margin-top:16px; padding:16px; border:1px solid var(--line); border-radius:var(--radius); }
summary { color:var(--brand); font-weight:600; cursor:pointer; }
form { display:flex; flex-wrap:wrap; align-items:end; gap:12px; margin-top:12px; }
form p { flex-basis:100%; margin:0; }
label { display:grid; gap:6px; flex:1 1 13rem; min-width:0; }
input { min-width:0; }
section { margin-top:16px; padding-top:12px; border-top:1px solid var(--line); }
</style>
