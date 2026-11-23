<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import { createCommand, publishNotice, type NoticeInput } from '@hongyan/contracts';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { message, noAccess } from '@hongyan/ui/usePageRead';
import AttendanceRoster from '../attendance/AttendanceRoster.vue';

const props = defineProps<{ activityId: string; writesPaused?: boolean }>();
const emit = defineEmits<{ published: [id: string]; cancel: []; denied: [] }>();
const title = ref(''), body = ref(''), requiresAck = ref(true);
const mode = ref<NoticeInput['recipient_mode']>('accepted'), students = ref<string[]>([]);
const sending = ref(false), error = ref('');
const command = createCommand();
let active = true;
onScopeDispose(() => { active = false; });

async function submit() {
  if (sending.value || props.writesPaused) return;
  const input: NoticeInput = {
    notice_kind: 'other', title: title.value.trim(), body: body.value.trim(),
    requires_ack: requiresAck.value, recipient_mode: mode.value,
    ...(mode.value === 'selected' && { recipient_student_ids: students.value }),
  };
  sending.value = true;
  error.value = '';
  try {
    const { data } = await publishNotice({
      path: { id: props.activityId }, body: input, throwOnError: true,
      headers: command.headers('publish_notice', props.activityId, input),
    });
    command.confirmed();
    if (active) emit('published', data.data.id);
  } catch (reason) {
    if (!active) return;
    error.value = message(reason);
    if (noAccess(reason)) emit('denied');
  } finally { sending.value = false; }
}
</script>
<template>
  <form class="publish-form" @submit.prevent="submit">
    <h3>发布通知</h3>
    <fieldset :disabled="sending || writesPaused">
      <label>通知标题<input required maxlength="150" v-model="title" /></label>
      <label>通知正文<textarea required maxlength="6000" rows="5" v-model="body" /></label>
      <label>接收范围
        <UiSelect label="接收范围" v-model="mode" :disabled="sending || writesPaused" :options="[
          { value: 'accepted', label: '已录取人员' },
          { value: 'all_applicants', label: '全部有效报名人员' },
          { value: 'selected', label: '指定人员' },
        ]" />
      </label>
      <fieldset v-if="mode === 'selected'">
        <legend>选择接收人</legend>
        <AttendanceRoster v-model="students" :activity-id="activityId" for-notice @denied="$emit('denied')" />
      </fieldset>
      <label class="ack-option"><input type="checkbox" v-model="requiresAck" />需要学生确认</label>
      <div class="page-actions">
        <button class="primary" :disabled="!title.trim() || !body.trim() || (mode === 'selected' && !students.length)">发布</button>
        <button type="button" @click="$emit('cancel')">取消</button>
      </div>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>
<style scoped>
.publish-form { max-width: 44rem; }
.publish-form > fieldset { display: grid; gap: 16px; padding: 0; margin: 0; border: 0; }
.publish-form > fieldset > label { display: grid; gap: 6px; }
.publish-form textarea { resize: vertical; }
.publish-form :deep(.platform-select) { --select-width: 12rem; }
.publish-form > fieldset > .ack-option { display: flex; align-items: center; }
</style>
