<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  createActivity,
  getManagedActivity,
  updateActivityDraft,
  submitActivity,
  withdrawActivityReview,
  createCommand,
  type ActivityInput,
  type ActivityDraftPatch,
  type ManagedActivityDetail,
  type ActivityRevision,
} from '@hongyan/contracts';

import UiIcon from '@hongyan/ui/UiIcon.vue';
import ActivityHistory from './ActivityHistory.vue';
import { fieldGroups, activityFields as fields } from '@hongyan/ui/activityFields';
import { revisionLabels } from '@hongyan/ui/activityDisplay';

const props = defineProps<{ writesPaused?: boolean; snapshot?: ManagedActivityDetail }>();
const emit = defineEmits<{ loaded: [detail: ManagedActivityDetail] }>();
const route = useRoute(),
  router = useRouter(),
  id = computed(() => String(route.params.id ?? ''));
const detail = ref<ManagedActivityDetail>(),
  form = ref<Record<string, string>>({}),
  base = ref<Record<string, string>>({});
const reason = ref(''),
  message = ref(''),
  confirmation = ref<{ id: string; text: string }>(),
  readError = ref(''),
  fieldErrors = ref<Record<string, string>>({}),
  busy = ref(false),
  loading = ref(false),
  conflict = ref(false);
const pending = computed(() => detail.value?.current_review?.status === 'pending');
const readonly = computed(
  () =>
    !!pending.value ||
    ['cancelled', 'completed', 'archived'].includes(detail.value?.activity.status ?? '') ||
    (detail.value?.working_snapshot.content.schedule.schedule_type &&
      detail.value.working_snapshot.content.schedule.schedule_type !== 'continuous'),
);
function formValues(item?: ActivityRevision['content']) {
  const props = {
    ...item,
    ...(item?.schedule.schedule_type === 'continuous' ? item.schedule : {}),
  } as Record<string, unknown>;
  return Object.fromEntries(
    fields.map(([key, , type]) => {
      const value = props[key];
      return [
        key,
        type === 'datetime-local' && value
          ? new Date(Date.parse(String(value)) + 8 * 3600000).toISOString().slice(0, 19)
          : String(value ?? (key === 'capacity' ? 1 : '')),
      ];
    }),
  );
}
let serial = 0;
async function load(preserve = false, snapshot?: ManagedActivityDetail) {
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
    if (data && !snapshot) emit('loaded', data);
    base.value = formValues(data?.working_snapshot.content);
    form.value = { ...base.value, ...(preserve ? Object.fromEntries(local) : {}) };
  } catch (e) {
    if (n === serial) {
      detail.value = undefined;
      readError.value = e instanceof Error ? e.message : '读取失败';
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
      (e.body?.details ?? []).map((d) => [d.field ?? '', d.message]),
    );
  }
}
function payload(partial: boolean) {
  const result: Record<string, unknown> = {},
    v = form.value;
  for (const [k, , type] of fields) {
    if (k === 'starts_at' || k === 'ends_at' || k.startsWith('expected_hours')) continue;
    if ((partial && v[k] === base.value[k]) || (!v[k] && !partial)) continue;
    result[k] =
      type === 'datetime-local' && v[k]
        ? new Date(v[k] + '+08:00').toISOString()
        : type === 'number'
          ? Number(v[k])
          : v[k];
  }
  if (!partial || v.starts_at !== base.value.starts_at || v.ends_at !== base.value.ends_at) {
    if (!v.starts_at || !v.ends_at) throw Error('请填写完整的开始与结束时间');
    result.schedule = {
      schedule_type: 'continuous',
      starts_at: new Date(v.starts_at + '+08:00').toISOString(),
      ends_at: new Date(v.ends_at + '+08:00').toISOString(),
    };
  }
  if (
    !partial ||
    v.expected_hours !== base.value.expected_hours ||
    v.expected_hours_basis !== base.value.expected_hours_basis
  ) {
    if (!!v.expected_hours !== !!v.expected_hours_basis) throw Error('预计时长和口径须成对填写');
    if (v.expected_hours || partial) {
      result.expected_hours = v.expected_hours || null;
      result.expected_hours_basis = v.expected_hours_basis || null;
    }
  }
  return result;
}
const command = createCommand();
async function run(action: 'save' | 'submit' | 'withdraw') {
  if (busy.value || props.writesPaused) return;
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
      if (e instanceof ApiError && !e.body) message.value = '写入结果尚未确认，可用相同内容重试。';
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
    base.value = {};
    form.value = {};
    reason.value = '';
    return load(false, props.snapshot);
  },
  { immediate: true },
);
const dirty = computed(() => fields.some(([k]) => form.value[k] !== base.value[k]));
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
    message.value = '活动已更新，请刷新版本并复核修改。';
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
    <component :is="id ? 'h2' : 'h1'">{{ id ? '活动编辑与送审' : '新建单次活动' }}</component>
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
          detail.current_review.snapshot.content.schedule.schedule_type === 'continuous' &&
          !readonly
        "
        :disabled="dirty || busy || writesPaused || conflict"
        @click="form = formValues(detail.current_review.snapshot.content)"
      >
        使用版本 {{ detail.current_review.revision }} 的内容重新编辑
      </button>
    </div>
    <form id="activity-form" class="activity-form" @submit.prevent="run('save')">
      <fieldset v-for="group in fieldGroups" :key="group.title" :disabled="!!readonly || busy">
        <legend>
          <UiIcon :name="group.icon" />{{ group.title }}
          <small v-if="group.icon === 'Calendar'">北京时间</small>
        </legend>
        <div class="field-grid">
          <label
            v-for="[key, title, type] in group.fields"
            :key="key"
            :class="{ wide: type === 'textarea' }"
          >
            <span>{{ title }}</span>
            <UiSelect
              v-if="type === 'select'"
              :label="title"
              v-model="form[key]"
              :disabled="!!readonly || busy"
              :options="[
                { value: '', label: '选填' },
                { value: 'per_occurrence', label: '单次' },
                { value: 'whole_activity', label: '整期' },
              ]"
            />
            <textarea
              v-else-if="type === 'textarea'"
              v-model="form[key]"
              rows="2"
              :aria-invalid="!!fieldErrors[key]"
            />
            <input
              v-else
              v-model="form[key]"
              :type="type || 'text'"
              :step="type === 'datetime-local' ? 1 : undefined"
              :aria-invalid="!!fieldErrors[key]"
              :aria-describedby="fieldErrors[key] ? 'error-' + key : undefined"
            />
            <small v-if="fieldErrors[key]" :id="'error-' + key">{{ fieldErrors[key] }}</small>
          </label>
        </div>
      </fieldset>
    </form>
    <div class="editor-actions">
      <p v-if="dirty && id">请先保存修改，再提交审核。</p>
      <div class="page-actions">
        <button
          type="submit"
          form="activity-form"
          :class="{ primary: !detail || dirty }"
          :disabled="!!readonly || busy || writesPaused || conflict"
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
    <ActivityHistory v-if="detail" :id="detail.activity.id" :key="detail.activity.id" />
  </template>
</template>
<style scoped>
.version-strip {
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
.field-grid label {
  display: grid;
  gap: 5px;
  font-size: 14px;
}
.field-grid .wide {
  grid-column: 1 / -1;
}
.field-grid small {
  color: var(--danger);
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
