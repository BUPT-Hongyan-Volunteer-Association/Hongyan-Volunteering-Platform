<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ApiError, applyForActivity, createCommand, type Activity, type Registration, type RegistrationInput, type Student } from '@hongyan/contracts';
import { activeRegistrationStatuses, registrationItemLabel, sameRegistrationItem, createSelectionCheck } from '@hongyan/contracts/activity';
import { registrationLabels } from '../registrations/labels';

const props = defineProps<{ activity: Activity; student?: Student; refreshing: boolean }>();
const emit = defineEmits<{ applied: [registrations: Registration[]]; refresh: [] }>();
const command = createCommand();
const saving = ref(false), error = ref(''), success = ref('');
const selected = ref(new Set<string>());
const choices = ref<Record<string, string[]>>({});
const texts = ref<Record<string, string>>({});
const items = computed(() => props.activity.registration_items ?? []);
const batch = computed(() => props.activity.registration_mode === 'batch');
const questions = computed(() => props.activity.questions ?? []);
const mine = computed(() => props.activity.my_registrations ?? []);
const savedAnswer = computed(() => {
  for (const row of mine.value) {
    if (row.questionnaire_version === props.activity.questionnaire_version && row.answers) return row;
    const previous = row.answer_history?.find(entry => entry.questionnaire_version === props.activity.questionnaire_version);
    if (previous) return previous;
  }
});
const existing = computed(() => new Map(mine.value.map(row => [row.item_id, row])));
const inventory = computed(() => new Map((props.activity.item_availability ?? []).map(row => [row.item_id, row])));
const isOpen = computed(() => !!props.student && props.activity.status === 'published' && props.activity.registration_phase === 'open');
const wholeStatus = computed(() => existing.value.get(undefined)?.status ?? props.activity.my_registration_status);
const wholeRemaining = computed(() => inventory.value.get(undefined)?.remaining);
const itemOptions = computed(() => {
  const held = new Set(selected.value);
  for (const row of mine.value) {
    if (row.item_id && activeRegistrationStatuses.includes(row.status)) held.add(row.item_id);
  }
  const check = createSelectionCheck(props.activity, items.value.filter(item => held.has(item.id)));
  return new Map(items.value.map(item => {
    const prior = existing.value.get(item.id);
    const pool = inventory.value.get(item.id);
    const reason = prior && prior.status !== 'withdrawn' ? registrationLabels[prior.status]
      : pool?.remaining === 0 ? '报名已满' : check(held.has(item.id) ? undefined : item);
    return [item.id, { item, label: pool?.item_label ?? registrationItemLabel(item), remaining: pool?.remaining, reason }];
  }));
});
const wholeAvailable = computed(() => (!wholeStatus.value || wholeStatus.value === 'withdrawn') && wholeRemaining.value !== 0);
const canApply = computed(() => isOpen.value && (batch.value ? items.value.some(item => !itemOptions.value.get(item.id)!.reason) : wholeAvailable.value));
const buttonLabel = computed(() => {
  if (saving.value) return '正在提交…';
  if (!batch.value && wholeStatus.value && (wholeStatus.value !== 'withdrawn' || !canApply.value)) return registrationLabels[wholeStatus.value];
  if (!batch.value && wholeRemaining.value === 0) return '报名已满';
  return !batch.value && wholeStatus.value === 'withdrawn' ? '重新申请报名' : '申请报名';
});
watch(() => props.activity, (current, previous) => {
  if (!previous) return;
  const beforeItems = new Map(previous.registration_items?.map(item => [item.id, item]));
  const unchangedIds = new Set(current.registration_items?.filter(item => {
    const before = beforeItems.get(item.id);
    return before && sameRegistrationItem(before, item);
  }).map(item => item.id));
  const kept = new Set([...selected.value].filter(id => unchangedIds.has(id)));
  const itemsChanged = kept.size !== selected.value.size;
  if (itemsChanged) {
    selected.value = kept;
    error.value = '报名项目已调整，请重新选择变更的岗位或时段';
  }
  if (previous.questionnaire_version === current.questionnaire_version) return;
  const previousQuestions = new Map(previous.questions?.map(q => [q.id, q]));
  const validChoices: Record<string, string[]> = {}, validTexts: Record<string, string> = {};
  for (const q of current.questions ?? []) {
    const before = previousQuestions.get(q.id);
    if (!before || before.type !== q.type || before.title !== q.title || before.description !== q.description) continue;
    if (q.type === 'text') validTexts[q.id] = texts.value[q.id] ?? '';
    else {
      const oldLabels = new Map(before.options?.map(option => [option.id, option.label]));
      const unchanged = new Set(q.options?.filter(option => oldLabels.get(option.id) === option.label).map(option => option.id));
      validChoices[q.id] = (choices.value[q.id] ?? []).filter(id => unchanged.has(id));
    }
  }
  choices.value = validChoices;
  texts.value = validTexts;
  error.value = itemsChanged ? '报名项目和问卷已更新，请重新选择变更的项目并复核答案' : '问卷已更新，请复核后提交';
});
function fail(message: string, id?: string) {
  error.value = message;
  if (id) void nextTick(() => document.getElementById(id)?.focus());
}
async function submit() {
  if (!canApply.value || saving.value || props.refreshing) return;
  error.value = ''; success.value = '';
  const body: RegistrationInput = { published_revision: props.activity.published_revision };
  if (batch.value) {
    if (!selected.value.size) return fail('请选择报名项目', 'signup-items');
    for (const id of selected.value) {
      const option = itemOptions.value.get(id);
      if (!option) return fail('所选项目已变更，请重新选择', 'signup-items');
      if (option.reason) return fail(option.label + ' · ' + option.reason, 'signup-items');
    }
    body.item_ids = [...selected.value];
  }
  if (props.activity.questionnaire_version) body.questionnaire_version = props.activity.questionnaire_version;
  if (questions.value.length && !savedAnswer.value) {
    body.answers = [];
    for (const question of questions.value) {
      const text = texts.value[question.id]?.trim(), ids = choices.value[question.id];
      if (question.type === 'text' && text) body.answers.push({ question_id: question.id, text });
      else if (question.type !== 'text' && ids?.length) body.answers.push({question_id: question.id, option_ids: ids});
      else if (question.required) return fail('请填写必答题「' + question.title + '」', 'question-' + question.id);
    }
  }
  saving.value = true;
  try {
    const id = props.activity.id;
    const {data} = await applyForActivity({path:{id}, body, headers:command.headers('apply_for_activity',id,body), throwOnError:true});
    command.confirmed();
    selected.value.clear();
    success.value = batch.value ? '已提交 ' + data.data.items.length + ' 项报名' : '报名已提交';
    emit('applied', data.data.items);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '报名提交失败，请重试';
    if (e instanceof ApiError) {
      const details = e.body?.details?.map(d => d.message).filter(msg => msg && msg !== error.value);
      if (details?.length) error.value += ' · ' + [...new Set(details)].join('，');
      if (e.status === 409) emit('refresh');
    }
  } finally { saving.value = false; }
}
</script>
<template>
  <form class="signup" @submit.prevent="submit">
    <fieldset v-if="batch" id="signup-items" tabindex="-1" class="signup-group">
      <legend>报名项目</legend>
      <label v-for="{ item, label, remaining, reason } in itemOptions.values()" :key="item.id" class="signup-item">
        <input v-if="student" v-model="selected" type="checkbox" :value="item.id"
          :disabled="!isOpen || saving || (!selected.has(item.id) && !!reason)" />
        <span><strong>{{ label }}</strong>
          <small>录取 {{ item.capacity }} 人 · 候补 {{ item.waitlist_capacity }} 人<span v-if="remaining !== undefined"> · 剩余可报 {{ remaining }}</span></small>
        </span><small v-if="reason" class="item-status">{{ reason }}</small>
      </label>
    </fieldset>
    <section v-if="student && questions.length && (canApply || savedAnswer)" class="questions">
      <h2>报名问卷</h2>
      <p class="identity">{{ [student.name, student.student_no, student.college].filter(Boolean).join(' · ') }}</p>
      <template v-if="savedAnswer">
        <p>已提交本版问卷，补报时共用这份答卷</p>
        <dl v-for="a in savedAnswer.answers" :key="a.question_id"><dt>{{ a.title }}</dt><dd>{{ a.text || a.labels?.join('、') || '未填写' }}</dd></dl>
      </template>
      <fieldset v-else v-for="(question, index) in questions" :key="question.id" :id="'question-' + question.id" tabindex="-1" :disabled="saving" class="signup-group">
        <legend>{{ index + 1 }}. {{ question.title }} <small>{{ question.required ? '必答' : '选答' }}</small></legend>
        <p v-if="question.description">{{ question.description }}</p>
        <textarea v-if="question.type === 'text'" v-model="texts[question.id]" maxlength="6000" rows="3" :aria-label="question.title" />
        <label v-else v-for="option in question.options" :key="option.id" class="answer-option">
          <input v-if="question.type === 'single'" type="radio" :name="question.id" :checked="choices[question.id]?.includes(option.id)"
            @change="choices[question.id] = [option.id]" />
          <input v-else type="checkbox" :checked="choices[question.id]?.includes(option.id)" @change="choices[question.id] = ($event.target as HTMLInputElement).checked ? [...(choices[question.id] ?? []), option.id] : choices[question.id].filter(id => id !== option.id)" />
          {{ option.label }}
        </label>
      </fieldset>
    </section>
    <footer class="detail-footer">
      <button class="primary" type="submit" :disabled="!canApply || saving || refreshing">{{ buttonLabel }}</button>
      <small v-if="error" role="alert">{{ error }}</small>
      <small v-else-if="success" role="status">{{ success }}</small>
      <small v-else-if="!student">需要学生身份才能报名</small>
      <small v-else-if="!isOpen && !wholeStatus">{{ activity.registration_phase === 'not_open' ? '尚未开放报名' : '当前报名已关闭' }}</small>
      <slot />
    </footer>
  </form>
</template>
<style scoped>
.signup { padding-block: 8px; }
.signup-group { min-width: 0; border: 0; margin: 0 0 16px; padding: 0; }
legend, h2 { font-weight: 650; font-size: 17px; padding: 0; margin: 8px 0; }
legend small, .identity, small { color: var(--muted); font-size: 13px; font-weight: 400; }
.signup-item, .answer-option { display: flex; align-items: center; gap: 10px; padding: 10px 4px; min-height: 44px; border-bottom: 1px solid var(--line); }
.signup-item small { display: block; }
.item-status { margin-left: auto; }
.questions { max-width: 52rem; }
.questions p, .questions dd { white-space: pre-wrap; }
.questions textarea { width: 100%; }
.questions dl { display: grid; grid-template-columns: minmax(6em, 1fr) 2fr; }
input[type=checkbox], input[type=radio] { flex: 0 0 auto; height: 17px; width: 17px; accent-color: var(--brand); }
.detail-footer { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:6px 12px; padding-block:14px; border-top:1px solid var(--line); background:white; }
.detail-footer .primary { min-width:170px; }
@media (max-width:700px) {
  .detail-footer { position:fixed; z-index:4; inset:auto 0 0; display:grid; grid-template-columns:1fr auto; gap:3px 8px; padding:8px 16px max(6px, env(safe-area-inset-bottom)); }
  .detail-footer .primary { grid-column:1; grid-row:1; min-width:0; width:100%; }
  .detail-footer small { grid-column:1 / -1; grid-row:2; text-align:center; }
  .detail-footer :slotted(.contact-btn) { grid-column:2; grid-row:1; }
  .detail-footer:not(:has(.contact-btn)) { grid-template-columns:1fr; }
}
</style>
