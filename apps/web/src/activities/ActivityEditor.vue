<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  createActivity,
  getManagedActivity,
  listActivityRevisions,
  getActivityRevision,
  updateActivityDraft,
  submitActivity,
  withdrawActivityReview,
  createCommand,
  type ActivityInput,
  type ActivityDraftPatch,
  type ManagedActivityDetail,
  type ActivityRevision,
} from '@hongyan/contracts';

const route = useRoute(),
  router = useRouter(),
  id = computed(() => String(route.params.id ?? ''));
const detail = ref<ManagedActivityDetail>(),
  history = ref<ActivityRevision[]>([]),
  viewed = ref<ActivityRevision>(),
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
const fields = [
  ['title', '活动标题'],
  ['description', '服务内容'],
  ['beneficiaries', '服务对象'],
  ['campus', '校区'],
  ['location', '活动地点'],
  ['meeting_point', '集合地点'],
  ['transport_notes', '交通说明'],
  ['capacity', '计划名额', 'number'],
  ['starts_at', '开始时间', 'datetime-local'],
  ['ends_at', '结束时间', 'datetime-local'],
  ['registration_opens_at', '报名开放', 'datetime-local'],
  ['registration_closes_at', '报名截止', 'datetime-local'],
  ['result_expected_at', '预计结果公布', 'datetime-local'],
  ['eligibility_text', '报名条件'],
  ['selection_text', '录取说明'],
  ['group_join_instructions', '入群方式'],
  ['contact_text', '联系渠道'],
  ['hours_rule_text', '时长认定说明'],
  ['hours_import_expected_at', '预计时长导入时间', 'datetime-local'],
  ['expected_hours', '预计时长'],
  ['expected_hours_basis', '预计时长口径', 'select'],
  ['safety_notes', '安全或培训说明'],
];
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
async function load(preserve = false) {
  const n = ++serial,
    local = Object.entries(form.value).filter(([k, v]) => v !== base.value[k]);
  loading.value = true;
  readError.value = '';
  message.value = '';
  fieldErrors.value = {};
  conflict.value = false;
  viewed.value = undefined;
  try {
    let data: ManagedActivityDetail | undefined,
      versions: ActivityRevision[] = [];
    if (id.value) {
      const path = { id: id.value };
      const [d, h] = await Promise.all([
        getManagedActivity({ path, throwOnError: true }),
        listActivityRevisions({ path, throwOnError: true }),
      ]);
      data = d.data.data;
      versions = h.data.data.items;
    }
    if (n !== serial) return;
    detail.value = data;
    history.value = versions;
    base.value = formValues(data?.working_snapshot.content);
    form.value = { ...base.value, ...(preserve ? Object.fromEntries(local) : {}) };
  } catch (e) {
    if (n === serial) {
      detail.value = undefined;
      history.value = [];
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
  if (busy.value) return;
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
  if (nextId !== target) await router.replace({ path: '/managed/' + nextId + '/edit', state: { savedDraftId: nextId } });
  else await load();
}
async function inspect(revision: number) {
  try {
    viewed.value = (
      await getActivityRevision({ path: { id: id.value, revision }, throwOnError: true })
    ).data.data;
  } catch (e) {
    report(e);
  }
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
    return load();
  },
  { immediate: true },
);
const dirty = computed(() => fields.some(([k]) => form.value[k] !== base.value[k]));
</script>
<template>
  <RouterLink v-if="!id" to="/managed">返回活动管理</RouterLink>
  <h1>{{ id ? '活动编辑与送审' : '新建单次活动' }}</h1>
  <p v-if="loading">正在读取…</p>
  <p v-if="confirmation?.id === id" role="status">{{ confirmation.text }}</p>
  <p v-if="readError" role="alert">最新版本读取失败：{{ readError }}</p>
  <p v-if="message" role="status">{{ message }}</p>
  <button v-if="conflict || (id && !detail && !loading)" @click="load(confirmation?.id !== id)">
    刷新版本并复核
  </button>
  <template v-if="!loading && (!id || detail)">
    <p v-if="detail">
      工作版本 {{ detail.working_snapshot.revision }} ·
      {{ detail.working_snapshot.content.location }} · {{ detail.working_snapshot.revision_state }}
    </p>
    <p v-if="detail?.published_snapshot">
      公开版本 {{ detail.published_snapshot.revision }} ·
      {{ detail.published_snapshot.content.location }}
    </p>
    <p v-if="detail?.current_review?.reason">处理意见：{{ detail.current_review.reason }}</p>
    <form @submit.prevent="run('save')">
      <fieldset :disabled="!!readonly || busy">
        <legend>招募信息（北京时间）</legend>
        <label v-for="[key, title, type] in fields" :key="key"
          >{{ title }}
          <select v-if="type === 'select'" v-model="form[key]">
            <option value="">选填</option>
            <option value="per_occurrence">单次</option>
            <option value="whole_activity">整期</option>
          </select>
          <input
            v-else
            v-model="form[key]"
            :type="type || 'text'"
            :step="type === 'datetime-local' ? 1 : undefined"
          /><small v-if="fieldErrors[key]">{{ fieldErrors[key] }}</small></label
        >
        <button type="submit" :disabled="conflict">保存草稿</button>
      </fieldset>
    </form>
    <button
      v-if="detail && !readonly && detail.working_snapshot.revision_state === 'draft'"
      :disabled="busy || dirty || conflict"
      @click="run('submit')"
    >
      提交审核
    </button>
    <p v-if="dirty && id">请先保存修改，再提交审核。</p>
    <template v-if="pending"
      ><label>撤回原因 <input v-model="reason" /></label
      ><button :disabled="busy || conflict || !reason.trim()" @click="run('withdraw')">
        撤回送审
      </button></template
    >
    <details v-if="history.length">
      <summary>版本历史</summary>
      <button v-for="v in history" @click="inspect(v.revision)">
        版本 {{ v.revision }} · {{ v.revision_state }}
      </button>
      <pre v-if="viewed">{{ viewed.content }}</pre>
    </details>
  </template>
</template>
<style scoped>
fieldset {
  border: 1px solid #e4e9f0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr));
  gap: 12px;
  padding: 16px;
}
fieldset label {
  display: grid;
  gap: 4px;
}
small {
  color: #913722;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
