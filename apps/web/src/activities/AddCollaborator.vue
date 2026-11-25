<script setup lang="ts">
import MemberCandidateSearch from '@hongyan/ui/MemberCandidateSearch.vue';
import { computed, ref } from 'vue';
import { ApiError, addActivityMember, createCommand,
  type Activity, type ActivityMemberCandidate, type ActivityMemberList } from '@hongyan/contracts';

const props = defineProps<{ activity: Activity; team: ActivityMemberList; paused: boolean }>();
const emit = defineEmits<{ saved: [string, ActivityMemberList]; refresh: [] }>();
const command = createCommand();
const number = ref(''), reason = ref(''), notice = ref('');
const candidate = ref<ActivityMemberCandidate>(), version = ref(0);
const saving = ref(false);
const member = computed(() => props.team.items.find(person => person.account_id === candidate.value?.account_id));

function clear() {
  version.value = props.team.version;
  candidate.value = undefined;
  reason.value = '';
  notice.value = '';
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.status === 422) {
    notice.value = error.message;
  } else if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status ?? 0)) {
    clear();
    notice.value = error.status === 409 ? '团队已变化，请重新查找并核对' : error.message;
    emit('refresh');
  } else notice.value = '请求结果未确认，请重试';
}

async function add() {
  if (saving.value || props.paused || !candidate.value || member.value) return;
  const body = { account_id:candidate.value.account_id, reason:reason.value.trim(), expected_version:version.value };
  if (!body.reason) { notice.value = '请填写添加原因'; return; }
  const id = props.activity.id;
  const name = candidate.value.display_name;
  saving.value = true;
  try {
    const { data } = await addActivityMember({path:{id},body,headers:command.headers('add_activity_member',id,body),throwOnError:true});
    command.confirmed();
    clear();
    number.value = '';
    emit('saved', id, data.data);
    notice.value = name + '已加入本活动，身份为协作者';
  } catch (error) { failure(error); }
  finally { saving.value = false; }
}
</script>

<template>
  <details class="add-member">
    <summary>添加协作者</summary>
    <MemberCandidateSearch v-model="number" :activity-id="activity.id" label="协作者学号" action="查找负责人"
      :disabled="saving || paused" @clear="clear" @found="candidate = $event" @error="failure" />
    <section v-if="candidate" aria-label="候选人核对">
      <strong>{{ candidate.display_name }} · {{ candidate.student_no }}</strong>
      <p v-if="member">已是本活动{{ member.member_role === 'owner' ? '主负责人' : '协作者' }}，无需重复添加</p>
      <form v-else @submit.prevent="add">
        <p>将加入「{{ activity.title }}」（{{ activity.activity_code }}），仅获得本活动的协作权限</p>
        <label>添加原因（最多 500 字）<input v-model="reason" required maxlength="500" :disabled="saving" /></label>
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
