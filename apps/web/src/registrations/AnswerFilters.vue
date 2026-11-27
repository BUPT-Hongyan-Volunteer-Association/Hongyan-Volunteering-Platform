<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import type { QuestionVersion } from '@hongyan/contracts';

const props = defineProps<{ versions: QuestionVersion[] }>();
const emit = defineEmits<{ change: [encoded: string] }>();
let sequence = 0;
const rules = ref<{ key: number; question: string; option: string; text: string }[]>([]);
const questions = computed(() => {
  const result = new Map<string, QuestionVersion['questions'][number]>();
  for (const version of props.versions)
    for (const q of version.questions) {
      const key = JSON.stringify([q.id, q.title, q.type]);
      const merged = result.get(key);
      if (!merged) { result.set(key, { ...q, options: [...(q.options ?? [])] }); continue; }
      for (const option of q.options ?? []) {
        const existing = merged.options!.find(o => o.id === option.id);
        if (!existing) merged.options!.push(option);
        else if (!existing.label.split(' / ').includes(option.label))
          merged.options![merged.options!.indexOf(existing)] = { ...existing, label: existing.label + ' / ' + option.label };
      }
    }
  return result;
});
const options = computed(() => Array.from(questions.value, ([value, q]) => ({ value, label: q.title + '（' + ({text:'填空',single:'单选',multiple:'多选'})[q.type] + '）' })));
const encoded = computed(() => {
  const filters = rules.value.flatMap<{question_id:string; option_id?:string; answer_text?:string}>(rule => {
    const q = questions.value.get(rule.question);
    if (!q) return [];
    if (q.type === 'text' && rule.text.trim()) return [{question_id:q.id, answer_text:rule.text.trim()}];
    if (q.type !== 'text' && rule.option) return [{question_id:q.id, option_id:rule.option}];
    return [];
  });
  return filters.length ? JSON.stringify(filters) : '';
});
watch(encoded, value => emit('change', value));
function changeQuestion(index: number, value: string) {
  Object.assign(rules.value[index], { question: value, option: '', text: '' });
}
function add() {
  rules.value.push({key:++sequence, question:options.value[0]?.value ?? '', option:'', text:''});
}
</script>
<template>
  <div v-if="options.length" class="answer-filters">
    <div v-for="(rule, index) in rules" :key="rule.key" class="answer-rule">
      <UiSelect label="筛选题目" :options="options" :model-value="rule.question" @update:model-value="changeQuestion(index, $event)" />
      <input v-if="questions.get(rule.question)?.type === 'text'" type="search" placeholder="答案关键词" aria-label="答案关键词" v-model="rule.text" />
      <UiSelect v-else label="筛选答案" :options="[{value:'',label:'请选择答案'}, ...(questions.get(rule.question)?.options ?? []).map(o => ({value:o.id,label:o.label}))]" v-model="rule.option" />
      <button type="button" class="quiet compact" @click="rules.splice(index,1)">移除条件</button>
    </div>
    <button type="button" class="quiet compact" @click="add">{{ rules.length ? '添加答卷条件' : '按答卷筛选' }}</button>
  </div>
</template>
<style scoped>
.answer-filters { margin: 8px 0; }
.answer-rule { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; --select-width:16rem; }
</style>
