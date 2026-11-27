<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import ActivityDateField from '@hongyan/ui/ActivityDateField.vue';
import RecruitmentEditor from './RecruitmentEditor.vue';
import { formValues, buildPatch, recruitmentValues, recruitmentPatch } from './activityForm';
import { campuses } from '@hongyan/contracts/activity';
import { ref, computed, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  createActivity,
  getManagedActivity,
  updateActivityDraft,
  submitActivity,
  withdrawActivityReview,
  createCommand,
  type ActivityInputWritable as ActivityInput,
  type ActivityDraftPatchWritable as ActivityDraftPatch,
  type ManagedActivityDetail,
  type ActivityRevision,
} from '@hongyan/contracts';

import UiIcon from '@hongyan/ui/UiIcon.vue';
import { noAccess } from '@hongyan/ui/usePageRead';
import ActivityHistory from './ActivityHistory.vue';
import { fieldGroups, fieldLabel, activityFields as fields } from '@hongyan/ui/activityFields';
import {
  revisionLabels,
} from '@hongyan/ui/activityDisplay';

const props = defineProps<{ writesPaused?: boolean; snapshot?: ManagedActivityDetail }>();
const emit = defineEmits<{ loaded: [detail: ManagedActivityDetail]; denied: [] }>();
const route = useRoute(),
  router = useRouter(),
  id = computed(() => String(route.params.id ?? ''));
const detail = ref<ManagedActivityDetail>(),
  form = ref<Record<string, string>>({}),
  base = ref<Record<string, string>>({});
const contactRows = ref<string[]>(['']);
const savedContacts = computed(() => detail.value?.working_snapshot.content.contacts ?? []);
const contacts = computed(() => contactRows.value.map((value) => value.trim()).filter(Boolean));
const contactsChanged = computed(
  () =>
    contacts.value.length !== savedContacts.value.length ||
    contacts.value.some((value, index) => value !== savedContacts.value[index]),
);
function resetContacts(item?: ActivityRevision['content']) {
  const values = item?.contacts ?? [];
  contactRows.value = values.length ? [...values] : [''];
}
async function changeContactRows(remove?: number) {
  if (remove === undefined) contactRows.value.push('');
  else contactRows.value.splice(remove, 1);
  if (!contactRows.value.length) contactRows.value.push('');
  await nextTick();
  const index = Math.min(remove ?? contactRows.value.length - 1, contactRows.value.length - 1);
  document.getElementById('activity-contact-' + index)?.focus();
}
const recruitment = ref(recruitmentValues());
const savedRecruitment = computed(() => recruitmentValues(detail.value?.working_snapshot.content));
const changedRecruitment = computed(() => JSON.stringify(recruitment.value) !== JSON.stringify(savedRecruitment.value));
const quotaField = (key: string) => key === 'capacity' || key === 'waitlist_capacity';
const reason = ref(''),
  message = ref(''),
  confirmation = ref<{ id: string; text: string }>(),
  readError = ref(''),
  fieldErrors = ref<Record<string, string>>({}),
  busy = ref(false),
  loading = ref(false),
  conflict = ref(false);
watch(
  () => ({ ...form.value }),
  (values, previous) => {
    if (!Object.keys(fieldErrors.value).length) return;
    for (const [key] of fields) {
      if (values[key] === previous[key]) continue;
      delete fieldErrors.value[key];
      if (key === 'group_qr_id' && values.group_qr_id)
        delete fieldErrors.value.group_join_instructions;
      if (key.startsWith('duration_')) delete fieldErrors.value.schedule;
    }
    if (!Object.keys(fieldErrors.value).length) message.value = '';
  },
);
watch(contacts, () => {
  if (fieldErrors.value.contacts) {
    delete fieldErrors.value.contacts;
    if (!Object.keys(fieldErrors.value).length) message.value = '';
  }
});
const pending = computed(() => detail.value?.current_review?.status === 'pending');
const readonly = computed(
  () =>
    !!pending.value ||
    ['cancelled', 'completed', 'archived'].includes(detail.value?.activity.status ?? ''),
);
const restore = ref<ActivityRevision['content']>();
const imageLoading = ref(false);
let imageRequest = 0;
const options = [
  { value: '', label: '请选择校区' },
  ...campuses.map((value) => ({ value, label: value })),
];
function requirement(key: string) {
  if (['group_join_instructions', 'group_qr_id'].includes(key)) return '至少一项';
  if (['precautions', 'related_notes', 'safety_notes'].includes(key)) return '选填';
  return '';
}
function selectImage(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const n = ++imageRequest;
  imageLoading.value = false;
  delete fieldErrors.value.group_qr_id;
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    fieldErrors.value.group_qr_id = '请选择不超过 5 MB 的 PNG 或 JPEG 图片';
    return;
  }
  imageLoading.value = true;
  const reader = new FileReader();
  reader.onload = () => {
    if (n === imageRequest) form.value.group_qr_id = String(reader.result);
  };
  reader.onerror = () => {
    if (n === imageRequest) fieldErrors.value.group_qr_id = '读取失败，请重新选择图片';
  };
  reader.onloadend = () => {
    if (n === imageRequest) imageLoading.value = false;
  };
  reader.readAsDataURL(file);
}
function restoreVersion(item: ActivityRevision['content']) {
  restore.value = item;
  resetContacts(item);
  recruitment.value = recruitmentValues(item);
  form.value = formValues(item);
}
let serial = 0;
async function load(preserve = false, snapshot?: ManagedActivityDetail) {
  const keepContacts = preserve && contactsChanged.value;
  const keepRecruitment = preserve && changedRecruitment.value;
  const n = ++serial,
    local = Object.entries(form.value).filter(([k, v]) => v !== base.value[k]);
  loading.value = true;
  readError.value = '';
  message.value = '';
  fieldErrors.value = {};
  conflict.value = false;
  try {
    const data =
      snapshot ??
      (id.value
        ? (await getManagedActivity({ path: { id: id.value }, throwOnError: true })).data.data
        : undefined);
    if (n !== serial) return;
    detail.value = data;
    if (!preserve) restore.value = undefined;
    if (data && !snapshot) emit('loaded', data);
    if (!keepContacts) resetContacts(data?.working_snapshot.content);
    if (!keepRecruitment) recruitment.value = recruitmentValues(data?.working_snapshot.content);
    base.value = formValues(data?.working_snapshot.content);
    form.value = { ...base.value, ...(preserve ? Object.fromEntries(local) : {}) };
  } catch (e) {
    if (n === serial) {
      detail.value = undefined;
      readError.value = e instanceof Error ? e.message : '读取失败';
      if (noAccess(e)) emit('denied');
    }
  } finally {
    if (n === serial) loading.value = false;
  }
}
function report(e: unknown) {
  message.value = e instanceof Error ? e.message : '操作失败';
  if (e instanceof ApiError) {
    conflict.value = e.status === 409;
    fieldErrors.value = Object.fromEntries(
      (e.body?.details ?? []).map((d) => {
        const field = d.field?.replace(/^schedule\./, '') ?? '';
        if (field.startsWith('contacts.')) {
          const filledRows = contactRows.value.flatMap((value, index) =>
            value.trim() ? [index + 1] : [],
          );
          return [
            'contacts',
            '第 ' + filledRows[Number(field.split('.')[1])] + ' 项联系方式不能为空',
          ];
        }
        return [field, d.message];
      }),
    );
  }
}
function payload(partial: boolean) {
  const patch = buildPatch(form.value, base.value, detail.value?.working_snapshot.content, restore.value,
    contactsChanged.value ? contacts.value : undefined, partial);
  if (!partial || changedRecruitment.value) Object.assign(patch, recruitmentPatch(recruitment.value));
  if (recruitment.value.registration_mode === 'batch') {
    delete patch.capacity;
    delete patch.waitlist_capacity;
  }
  return patch;
}
const command = createCommand();
async function run(action: 'save' | 'submit' | 'withdraw') {
  if (
    imageLoading.value ||
    busy.value ||
    props.writesPaused ||
    (action === 'save' && id.value && !dirty.value)
  )
    return;
  busy.value = true;
  fieldErrors.value = {};
  confirmation.value = undefined;
  message.value = '';
  const target = id.value;
  const path = { id: target };
  let nextId = target;
  try {
    if (action === 'save' && !target) {
      const body = payload(false) as ActivityInput;
      const result = await createActivity({
        headers: command.headers('create', target, body),
        body,
        throwOnError: true,
      });
      nextId = result.data.data.id;
    } else {
      const d = detail.value!;
      if (action === 'save') {
        const body = {
          ...payload(true),
          expected_version: d.activity.version,
        } as ActivityDraftPatch;
        await updateActivityDraft({
          path,
          headers: command.headers(action, target, body),
          body,
          throwOnError: true,
        });
      } else if (action === 'submit') {
        const body = { expected_version: d.activity.version };
        await submitActivity({
          path,
          headers: command.headers(action, target, body),
          body,
          throwOnError: true,
        });
      } else {
        const r = d.current_review!,
          body = { expected_version: r.version, reason: reason.value };
        await withdrawActivityReview({
          path: { id: r.id },
          headers: command.headers(action, r.id, body),
          body,
          throwOnError: true,
        });
      }
    }
  } catch (e) {
    if (id.value === target) {
      report(e);
      if (target && noAccess(e)) emit('denied');
      if (Object.keys(fieldErrors.value).length) {
        await nextTick();
        // The fieldset becomes interactive when the request finishes.
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(
              '.field-grid .invalid :is(input,textarea,button):not([disabled])',
            )
            ?.focus(),
        );
      }
      if (e instanceof ApiError && !e.body) message.value = '写入结果尚未确认，可用相同内容重试';
    }
    return;
  } finally {
    busy.value = false;
  }
  command.confirmed();
  if (id.value !== target) return;
  confirmation.value = {
    id: nextId,
    text: { save: '草稿已保存', submit: '已送审，内容已冻结', withdraw: '已撤回' }[action],
  };
  if (nextId !== target)
    await router.replace({ path: '/managed/' + nextId + '/edit', state: { savedDraftId: nextId } });
  else await load();
}
watch(
  id,
  () => {
    if (confirmation.value?.id !== id.value) confirmation.value = undefined;
    if (id.value && window.history.state?.savedDraftId === id.value) {
      confirmation.value = { id: id.value, text: '草稿已保存' };
      window.history.replaceState({ ...window.history.state, savedDraftId: null }, '');
    }
    imageRequest++;
    imageLoading.value = false;
    base.value = {};
    form.value = {};
    reason.value = '';
    return load(false, props.snapshot);
  },
  { immediate: true },
);
const dirty = computed(
  () =>
    !!restore.value ||
    contactsChanged.value || changedRecruitment.value ||
    fields.some(([k]) => form.value[k] !== base.value[k]),
);
watch([() => props.snapshot, busy, loading], ([snapshot]) => {
  if (
    !snapshot ||
    !detail.value ||
    busy.value ||
    loading.value ||
    snapshot.activity.version <= detail.value.activity.version
  )
    return;
  if (dirty.value) {
    conflict.value = true;
    message.value = '活动已更新，请刷新版本并复核修改';
  } else {
    void load(false, snapshot);
  }
});
</script>

<template>
  <RouterLink v-if="!id" class="back-link" to="/managed"
    ><UiIcon name="ArrowLeft" />返回活动管理</RouterLink
  >
  <div class="page-heading">
    <component :is="id ? 'h2' : 'h1'">{{ id ? '活动编辑与送审' : '新建活动' }}</component>
  </div>
  <p v-if="loading" role="status">正在读取…</p>
  <p v-if="confirmation?.id === id" role="status" class="notice">{{ confirmation.text }}</p>
  <p v-if="readError" role="alert">最新版本读取失败：{{ readError }}</p>
  <p v-if="message" role="status" class="notice">{{ message }}</p>
  <button v-if="conflict || (id && !detail && !loading)" @click="load(confirmation?.id !== id)">
    <UiIcon name="Refresh" />刷新版本并复核
  </button>
  <template v-if="!loading && (!id || detail)">
    <div v-if="detail" class="version-strip">
      <p>
        <span class="state-chip">工作版本 {{ detail.working_snapshot.revision }}</span>
        {{ detail.working_snapshot.content.location }} ·
        {{ revisionLabels[detail.working_snapshot.revision_state] }}
      </p>
      <p v-if="detail.published_snapshot">
        <span class="state-chip neutral">公开版本 {{ detail.published_snapshot.revision }}</span>
        {{ detail.published_snapshot.content.location }}
      </p>
      <p v-if="detail.current_review?.reason">
        版本 {{ detail.current_review.revision }} 处理意见　{{ detail.current_review.reason }}
      </p>
      <button
        v-if="
          detail.current_review &&
          ['rejected', 'withdrawn'].includes(detail.current_review.status) &&
          detail.current_review.revision !== detail.working_snapshot.revision &&
          !readonly
        "
        :disabled="dirty || busy || writesPaused || conflict"
        @click="restoreVersion(detail.current_review.snapshot.content)"
      >
        使用版本 {{ detail.current_review.revision }} 的内容重新编辑
      </button>
    </div>
    <p v-if="!readonly" class="editor-hint">填写标题即可保存草稿。送审时请补齐各组字段，选填项和二选一项已标注</p>
    <ul v-if="Object.keys(fieldErrors).length" class="error-summary" aria-label="待修正字段">
      <li v-for="(error, key) in fieldErrors" :key="key">
        {{ fieldLabel(key) }} · {{ error }}
      </li>
    </ul>
    <form id="activity-form" class="activity-form" @submit.prevent="run('save')">
      <fieldset class="form-section" v-for="group in fieldGroups" :key="group.title" :disabled="!!readonly || busy">
        <legend>
          <UiIcon :name="group.icon" />{{ group.title }}
          <small v-if="group.icon === 'Calendar'">北京时间</small>
        </legend>
        <RecruitmentEditor v-if="group.icon === 'User'" v-model="recruitment" :disabled="!!readonly || busy">
          <template #whole>
            <div class="field-grid quota-fields">
              <div v-for="[key,title] in group.fields.filter(([k]) => quotaField(k))" :key="key" class="field" :class="{invalid:fieldErrors[key]}">
                <label :for="'activity-' + key">{{ title }}</label>
                <input :id="'activity-' + key" v-model="form[key]" type="number" :min="key === 'capacity' ? 1 : 0"
                  step="1" :aria-invalid="!!fieldErrors[key]">
                <small v-if="fieldErrors[key]" role="alert">{{ fieldErrors[key] }}</small>
              </div>
            </div>
          </template>
        </RecruitmentEditor>
        <div class="field-grid">
          <div
            v-for="[key, title, type] in group.fields.filter(([k]) => !quotaField(k))"
            :key="key"
            class="field"
            :class="{ wide: type === 'textarea' || type === 'contacts', invalid: fieldErrors[key] }"
          >
            <label :for="type === 'contacts' ? 'activity-contact-0' : 'activity-' + key"
              ><span>{{ title }}</span
              ><small v-if="requirement(key)" class="requirement">{{ requirement(key) }}</small></label
            >
            <UiSelect
              v-if="type === 'campus'"
              :id="'activity-' + key"
              :label="title"
              v-model="form[key]"
              :disabled="!!readonly || busy"
              :options="options"
            />
            <ActivityDateField
              v-else-if="type === 'date' || type === 'datetime-local'"
              :label="title"
              v-model="form[key]"
              :with-time="type === 'datetime-local'"
              :disabled="!!readonly || busy"
            />
            <template v-else-if="type === 'contacts'">
              <div v-for="(_, index) in contactRows" :key="index" class="contact-row">
                <input
                  :id="'activity-contact-' + index"
                  v-model="contactRows[index]"
                  :aria-label="'联系方式 ' + (index + 1)"
                  :aria-invalid="!!fieldErrors.contacts"
                  :aria-describedby="fieldErrors.contacts ? 'error-contacts' : undefined"
                  autocomplete="off"
                />
                <button
                  v-if="!readonly && contactRows.length > 1"
                  type="button"
                  class="quiet"
                  :aria-label="'删除联系方式 ' + (index + 1)"
                  @click="changeContactRows(index)"
                >
                  删除
                </button>
              </div>
              <button
                v-if="!readonly"
                class="add-contact"
                type="button"
                @click="changeContactRows()"
              >
                新增联系方式
              </button>
            </template>
            <template v-else-if="type === 'qr'">
              <img
                v-if="form[key]"
                class="group-qr"
                :src="
                  form[key].startsWith('data:')
                    ? form[key]
                    : '/api/v1/activity-group-images/' + form[key]
                "
                alt="入群二维码预览"
              />
              <label v-if="!readonly" class="upload-qr">
                <UiIcon name="Document" />{{ form[key] ? '更换二维码' : '上传二维码' }}
                <input
                  class="sr-only"
                  :id="'activity-' + key"
                  type="file"
                  accept="image/png,image/jpeg"
                  :aria-label="title"
                  @change="selectImage"
                />
              </label>
              <small class="hint">PNG 或 JPEG，最多 5 MB。可与入群文字同时提供</small>
              <button
                v-if="form[key] && !readonly"
                type="button"
                class="quiet"
                @click="form[key] = ''"
              >
                移除二维码
              </button>
            </template>
            <textarea
              v-else-if="type === 'textarea'"
              :id="'activity-' + key"
              v-model="form[key]"
              rows="2"
              :aria-label="title"
              :aria-invalid="!!fieldErrors[key]"
              :aria-describedby="fieldErrors[key] ? 'error-' + key : undefined"
            />
            <input
              v-else
              :id="'activity-' + key"
              v-model="form[key]"
              :type="type || 'text'"
              :placeholder="
                key === 'group_join_instructions' ? '填写群号或入群说明，也可上传二维码' : undefined
              "
              :aria-label="title"
              :aria-invalid="!!fieldErrors[key]"
              :aria-describedby="fieldErrors[key] ? 'error-' + key : undefined"
            />
            <small v-if="fieldErrors[key]" :id="'error-' + key" role="alert">{{
              fieldErrors[key]
            }}</small>
          </div>
        </div>
      </fieldset>
    </form>
    <div class="editor-actions">
      <p v-if="dirty && id">请先保存修改，再提交审核</p>
      <div class="page-actions">
        <button
          type="submit"
          form="activity-form"
          :class="{ primary: !detail || dirty }"
          :disabled="
            !!readonly || imageLoading || busy || writesPaused || conflict || (!!id && !dirty)
          "
        >
          <UiIcon name="Document" />保存草稿
        </button>
        <button
          v-if="detail && !readonly && detail.working_snapshot.revision_state === 'draft'"
          class="primary"
          :disabled="writesPaused || busy || dirty || conflict"
          @click="run('submit')"
        >
          <UiIcon name="Position" />提交审核
        </button>
      </div>
    </div>
    <div v-if="pending" class="withdraw">
      <label>撤回原因 <input v-model="reason" /></label
      ><button
        :disabled="writesPaused || busy || conflict || !reason.trim()"
        @click="run('withdraw')"
      >
        撤回送审
      </button>
    </div>
    <ActivityHistory v-if="detail" :id="detail.activity.id" :key="detail.activity.id" @denied="emit('denied')" />
  </template>
</template>
<style scoped>
.contact-row {
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: 36rem;
}
.contact-row input {
  flex: 1;
  min-width: 0;
}
.add-contact {
  justify-self: start;
}

.quota-fields { width: 100%; }
.version-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 20px;
}
.version-strip p {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0;
  font-size: 14px;
}
.activity-form,
.editor-actions,
.editor-hint,
.error-summary {
  max-width: 64rem;
}
.field .upload-qr {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--field-line);
  border-radius: 6px;
  min-height: 42px;
  padding: 0 14px;
  color: var(--brand);
  cursor: pointer;
}
.upload-qr:focus-within {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.field .quiet {
  justify-self: start;
}
.activity-form fieldset {
  border: 0;
  border-top: 1px solid var(--line);
  padding: 12px 0 22px;
  margin: 0;
  min-width: 0;
}
legend {
  font-size: 16px;
  font-weight: 650;
  padding: 0 12px 0 0;
}
legend .ui-icon {
  color: var(--brand);
  margin-right: 7px;
}
legend small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 450;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
}
.field-grid .field {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 5px;
  font-size: 14px;
}
.field-grid .wide {
  grid-column: 1 / -1;
}
.field-grid small {
  color: var(--danger);
}
.field label {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.field-grid .requirement,
.field-grid .hint,
.editor-hint {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}
.field-grid .group-qr {
  width: 150px;
  max-width: 100%;
  height: auto;
}
.field-grid input[type='file'] {
  max-width: 100%;
  font-size: 13px;
}
.error-summary {
  color: var(--danger);
  font-size: 14px;
}
.field-grid [aria-invalid='true'] {
  border-color: var(--danger);
}
.editor-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px 18px;
  border-top: 1px solid var(--line);
  padding-block: 16px;
}
.editor-actions p {
  color: var(--muted);
  font-size: 13px;
  margin: 0;
}
.withdraw {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
@media (max-width: 700px) {
  .field-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
