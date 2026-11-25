<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { findActivityMemberCandidate, type ActivityMemberCandidate } from '@hongyan/contracts';

const props = defineProps<{ activityId: string; label: string; action: string; disabled?: boolean }>();
const number = defineModel<string>({ required: true });
const emit = defineEmits<{ clear: []; found: [ActivityMemberCandidate]; error: [unknown] }>();
const looking = ref(false), hint = ref('');
let request: AbortController | undefined;
function reset() {
  request?.abort();
  looking.value = false;
  hint.value = '';
}
watch(() => [props.activityId, number.value], reset, { flush: 'sync' });
onScopeDispose(reset);
async function lookup() {
  if (props.disabled) return;
  reset();
  emit('clear');
  if (!/^\d{10}$/.test(number.value)) { hint.value = '请输入完整的十位学号'; return; }
  const current = new AbortController();
  request = current;
  looking.value = true;
  try {
    const { data } = await findActivityMemberCandidate({ path: { id: props.activityId },
      query: { student_no: number.value }, signal: current.signal, throwOnError: true });
    if (current.signal.aborted) return;
    if (data.data.items.length) emit('found', data.data.items[0]);
    else hint.value = '未找到匹配的有效负责人，请核对学号或联系老师确认资格';
  } catch (e) { if (!current.signal.aborted) emit('error', e); }
  finally { if (!current.signal.aborted) looking.value = false; }
}
</script>
<template>
  <form class="filter-bar" @submit.prevent="lookup">
    <label>{{ label }}<input v-model="number" autocomplete="off" inputmode="numeric" placeholder="完整十位学号" :disabled="disabled" @input="emit('clear')" /></label>
    <button :disabled="looking || disabled">{{ looking ? '正在核对…' : action }}</button>
  </form>
  <p v-if="hint" role="status">{{ hint }}</p>
</template>
