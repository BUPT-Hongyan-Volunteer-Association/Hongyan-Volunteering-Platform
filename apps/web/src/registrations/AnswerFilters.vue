<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import type { QuestionVersion } from '@hongyan/contracts';

const props = defineProps<{ versions: QuestionVersion[] }>();
const emit = defineEmits<{ change: [encoded: string] }>();
type Rule = { key:number; question:string; option:string; text:string };
type Condition = { questionnaire_version:string; question_id:string; option_id?:string; answer_text?:string };
const rules = ref<Rule[]>([]);
let sequence = 0;
const versionId = ref('');
const notice = ref('');
const versionsById = computed(() => new Map(props.versions.map(version => [version.questionnaire_version, version])));
watch(versionsById, versions => {
  if (!rules.value.length || versions.has(versionId.value)) return;
  rules.value = [];
  versionId.value = '';
  notice.value = '问卷已更新，原筛选条件已清除。';
});
const versionOptions = computed(() => {
  let historic = 0;
  return props.versions.map(version => ({
    value: version.questionnaire_version,
    label: version.is_current ? '当前问卷' : '历史问卷 ' + ++historic + (version.submitted_at ? ' · ' + localDateTime(version.submitted_at) : ''),
  }));
});
const types = { text:'填空', single:'单选', multiple:'多选' };
const questions = computed(() => versionsById.value.get(versionId.value)?.questions ?? []);
const questionOptions = computed(() => questions.value.map(q => ({
  value: q.id, label: q.title + '（' + types[q.type] + '）',
})));
function question(rule: Rule) {
  return questions.value.find(q => q.id === rule.question);
}
const encoded = computed(() => {
  const filters: Condition[] = [];
  for (const rule of rules.value) {
    const q = question(rule);
    if (!q) continue;
    const field = {questionnaire_version:versionId.value, question_id:q.id};
    if (q.type === 'text' && rule.text.trim()) filters.push({...field, answer_text:rule.text.trim()});
    if (q.type !== 'text' && rule.option) filters.push({...field, option_id:rule.option});
  }
  return filters.length ? JSON.stringify(filters) : '';
});
watch(encoded, value => emit('change', value));
function setQuestion(rule: Rule, id: string) {
  Object.assign(rule, {question:id, option:'', text:''});
}
function setVersion(version: string) {
  versionId.value = version;
  for (const rule of rules.value) setQuestion(rule, question(rule)?.id ?? questions.value[0]?.id ?? '');
}
function add() {
  notice.value = '';
  if (!rules.value.length) versionId.value = props.versions[0]?.questionnaire_version ?? '';
  rules.value.push({key:++sequence, question:questions.value[0]?.id ?? '', option:'', text:''});
}
</script>
<template>
  <p v-if="notice" role="status">{{ notice }}</p>
  <div v-if="versions.length" class="answer-filters">
    <label v-if="rules.length && versions.length > 1" class="answer-rule">问卷版本
      <UiSelect label="筛选问卷版本" :model-value="versionId" :options="versionOptions" @update:model-value="setVersion" />
    </label>
    <div v-for="(rule, index) in rules" :key="rule.key" class="answer-rule">
      <UiSelect label="筛选题目" class="question-filter" wrap-label :options="questionOptions"
        :model-value="rule.question" @update:model-value="setQuestion(rule, $event)" />
      <input v-if="question(rule)?.type === 'text'" type="search" placeholder="答案关键词" aria-label="答案关键词" v-model="rule.text" />
      <UiSelect v-else label="筛选答案" :options="[{value:'',label:'请选择答案'}, ...(question(rule)?.options ?? []).map(o => ({value:o.id,label:o.label}))]" v-model="rule.option" />
      <button type="button" class="quiet compact" @click="rules.splice(index,1)">移除条件</button>
    </div>
    <button type="button" class="quiet compact" @click="add">{{ rules.length ? '添加答卷条件' : '按答卷筛选' }}</button>
  </div>
</template>
<style scoped>
.answer-filters { margin: 8px 0; }
.answer-rule { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; --select-width:16rem; }
.question-filter { --select-width: min(32rem, 100%); }
</style>
