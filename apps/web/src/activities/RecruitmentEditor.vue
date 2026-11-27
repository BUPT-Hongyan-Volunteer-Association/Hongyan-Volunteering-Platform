<script setup lang="ts">
import type { RecruitmentForm } from './activityForm';
import UiSelect from '@hongyan/ui/UiSelect.vue';

const config = defineModel<RecruitmentForm>({ required: true });
const props = defineProps<{ disabled: boolean }>();
type Question = RecruitmentForm['questions'][number];
const types = [{ value: 'single', label: '单选题' }, { value: 'multiple', label: '多选题' }, { value: 'text', label: '填空题' }];
const modes = [{ value: 'whole', label: '整批报名' }, { value: 'batch', label: '分批报名' }];
const option = () => ({ id: crypto.randomUUID(), label: '' });

function setDay(item: RecruitmentForm['registration_items'][number], event: Event) {
  const value = (event.target as HTMLInputElement).value;
  item.start = value ? value + 'T00:00' : '';
}
function addItem(copy?: RecruitmentForm['registration_items'][number]) {
  config.value.registration_items.push({ role: '', start: '', end: '', allDay: false, capacity: 1, waitlist_capacity: 0,
    ...copy, id: crypto.randomUUID() });
}
function addQuestion() {
  config.value.questions.push({ id: crypto.randomUUID(), title: '', description: '', type: 'single', required: true, options: [option(),option()] });
}
function setType(q: Question, type: string) {
  q.type = type as Question['type'];
  if (type !== 'text' && !q.options.length) q.options.push(option(), option());
}
function moveQuestion(index: number, delta: number) {
  const questions = config.value.questions;
  const [q] = questions.splice(index, 1);
  questions.splice(index + delta, 0, q!);
}
</script>

<template>
  <div class="recruitment-editor">
    <label class="mode">报名方式
      <UiSelect label="报名方式" v-model="config.registration_mode" :options="modes" :disabled="props.disabled" />
    </label>
    <template v-if="config.registration_mode === 'batch'">
      <div class="choices">
        <label><input type="checkbox" v-model="config.allow_multiple_roles">允许多岗</label>
        <label><input type="checkbox" v-model="config.allow_multiple_slots">允许多时段</label>
      </div>
      <fieldset v-for="(item,i) in config.registration_items" :key="item.id" class="card">
        <legend>报名项 {{ i + 1 }}</legend>
        <div class="row">
          <label>岗位<input v-model="item.role" :aria-label="'第 '+(i+1)+' 项岗位'" placeholder="按时段报名时可留空"></label>
          <label class="inline"><input type="checkbox" v-model="item.allDay">全天</label>
        </div>
        <div class="row" v-if="item.allDay">
          <label>服务日期<input type="date" :value="item.start.slice(0,10)" @input="setDay(item,$event)"></label>
        </div>
        <div v-else class="row">
          <label>服务开始<input type="datetime-local" v-model="item.start"></label>
          <label>服务结束<input type="datetime-local" v-model="item.end"></label>
        </div>
        <div class="row">
          <label>录取人数<input type="number" min="1" step="1" v-model.number="item.capacity"></label>
          <label>候补人数<input type="number" min="0" step="1" v-model.number="item.waitlist_capacity"></label>
        </div>
        <div v-if="!disabled" class="tools">
          <button type="button" @click="addItem(item)">复制报名项</button>
          <button type="button" @click="config.registration_items.splice(i,1)">删除报名项</button>
        </div>
      </fieldset>
      <button v-if="!disabled" type="button" @click="addItem()">添加报名项</button>
    </template>
    <slot v-else name="whole" />
    <h3>报名问卷</h3>
    <fieldset v-for="(q,i) in config.questions" :key="q.id" class="card">
      <legend>第 {{ i + 1 }} 题</legend>
      <div class="row">
        <label>题型<UiSelect :label="'第 '+(i+1)+' 题题型'" :model-value="q.type" :options="types" :disabled="disabled" @update:model-value="setType(q,$event)" /></label>
        <label class="inline"><input type="checkbox" v-model="q.required">必答</label>
      </div>
      <label>题目<input v-model="q.title" :aria-label="'第 '+(i+1)+' 题题目'"></label>
      <label>题目说明<textarea v-model="q.description" rows="2" /></label>
      <template v-if="q.type !== 'text'">
        <div v-for="(o,j) in q.options" :key="o.id" class="option">
          <label>选项 {{ j+1 }}<input v-model="o.label" :aria-label="'第 '+(i+1)+' 题选项 '+(j+1)"></label>
          <button v-if="!disabled" type="button" :disabled="q.options.length <= 2" @click="q.options.splice(j,1)">删除选项</button>
        </div>
        <button v-if="!disabled" type="button" @click="q.options.push(option())">添加选项</button>
      </template>
      <div v-if="!disabled" class="tools">
        <button type="button" :disabled="i === 0" @click="moveQuestion(i,-1)">上移</button>
        <button type="button" :disabled="i + 1 === config.questions.length" @click="moveQuestion(i,1)">下移</button>
        <button type="button" @click="config.questions.splice(i,1)">删除题目</button>
      </div>
    </fieldset>
    <button v-if="!disabled" type="button" @click="addQuestion()">添加题目</button>
  </div>
</template>

<style scoped>
.recruitment-editor, .card, .card label, .mode { display:grid; min-width:0; gap:8px; }
.recruitment-editor { margin:2px 0 16px; justify-items:start; gap:12px; }
h3 { margin:8px 0 0; font-size:15px; }
.mode { min-width:11rem; }
.card { box-sizing:border-box; width:100%; margin:0; padding:10px 14px 14px; border:1px solid var(--line); border-radius:var(--radius); }
.card legend { padding:0 5px; font-weight:600; }
.card input, .card textarea { min-width:0; }
.card button { justify-self:start; }
.row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.tools, .choices, .option, .card .inline, .choices label { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.option { align-items:flex-end; }
.option label { flex:1; }
@media (max-width:600px) { .row { grid-template-columns:minmax(0,1fr); } }
</style>
