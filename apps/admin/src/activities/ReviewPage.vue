<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  getActivityReview,
  getManagedActivity,
  type Profile,
  listActivityReviews,
  reviewActivity,
  createCommand,
  type ActivityReview,
} from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import ActivitySnapshot from '@hongyan/ui/ActivitySnapshot.vue';
import { fieldLabel, fieldValue } from '@hongyan/ui/activityFields';
import { localDateTime, reviewLabels } from '@hongyan/ui/activityDisplay';
import RecordWorkspace from '@hongyan/ui/RecordWorkspace.vue';
import Pager from '@hongyan/ui/Pager.vue';
const props = defineProps<{ profile: Profile }>();
const route = useRoute(),
  router = useRouter(),
  review = ref<ActivityReview>(),
  rows = ref<ActivityReview[]>([]),
  total = ref(0),
  busy = ref(false),
  loading = ref(false),
  currentPending = ref(false),
  reason = ref(''),
  error = ref(''),
  notice = ref('');
const status = computed(
  () => String(route.query.status || 'pending') as 'pending' | 'approved' | 'rejected',
);
const page = computed(() => Number(route.query.page || 1));
const windowScroll = () => window.scrollY;
function scheduleReturn() {
  const origin = window.history.state?.scheduleReturn;
  return typeof origin === 'string' && /^\/schedule(?:\?|$)/.test(origin) ? origin : undefined;
}
let serial = 0,
  savedScroll = 0;
const command = createCommand();
const canDecide = computed(
  () =>
    currentPending.value &&
    review.value?.status === 'pending' &&
    review.value.submitted_by !== props.profile.account_id,
);
let completed: ActivityReview | undefined;
const queueError = ref('');
const queueLoading = ref(false);
let queueSerial = 0;
async function loadQueue() {
  const turn = ++queueSerial;
  queueError.value = '';
  queueLoading.value = true;
  rows.value = [];
  try {
    const { data } = await listActivityReviews({
      query: { status: status.value, page: page.value },
      throwOnError: true,
    });
    if (turn === queueSerial) {
      rows.value = data.data.items;
      total.value = data.data.total;
    }
  } catch (e) {
    if (turn === queueSerial)
      queueError.value = e instanceof Error ? e.message : '审核队列读取失败';
  } finally {
    if (turn === queueSerial) {
      queueLoading.value = false;
      if (!route.params.id) {
        await nextTick();
        if (turn === queueSerial) window.scrollTo(0, savedScroll);
      }
    }
  }
}
async function load() {
  const n = ++serial;
  loading.value = true;
  error.value = '';
  review.value = undefined;
  currentPending.value = false;
  try {
    if (route.params.id) {
      const id = String(route.params.id);
      const r = (await getActivityReview({ path: { id }, throwOnError: true })).data.data;
      const managed = (
        await getManagedActivity({ path: { id: r.activity_id }, throwOnError: true })
      ).data.data;
      if (n !== serial) return;
      review.value = r;
      currentPending.value =
        managed.current_review?.id === r.id &&
        ['pending_review', 'published'].includes(managed.activity.status);
      if (completed?.id === id) {
        const origin = scheduleReturn();
        if (origin)
          await router.push({
            path: '/schedule',
            query: router.resolve(origin).query,
            state: { scheduleNotice: notice.value },
          });
        else await router.push({ path: '/reviews', query: route.query });
      }
    }
  } catch (e) {
    if (n === serial)
      error.value = '读取最新数据失败：' + (e instanceof Error ? e.message : '请重试');
  } finally {
    if (n === serial) loading.value = false;
  }
}
async function decide(decision: 'approved' | 'rejected') {
  if (!review.value || busy.value) return;
  if (decision === 'rejected' && !reason.value.trim()) {
    error.value = '请填写驳回原因';
    return;
  }
  busy.value = true;
  error.value = '';
  const id = review.value.id,
    body = { decision, expected_version: review.value.version, reason: reason.value.trim() };
  const from = route.fullPath;
  try {
    const result = await reviewActivity({
      path: { id },
      headers: command.headers('decide', id, body),
      body,
      throwOnError: true,
    });
    command.confirmed();
    if (route.fullPath !== from) return;
    completed = result.data.data;
    review.value = completed;
    notice.value = completed.status === 'approved' ? '已批准发布' : '已驳回';
  } catch (e) {
    if (route.fullPath === from) {
      error.value = e instanceof Error ? e.message : '提交失败';
      if (e instanceof ApiError && !e.body) error.value = '审核结果尚未确认，可用相同内容重试。';
      if (e instanceof ApiError && [403, 404, 409].includes(e.status ?? 0)) {
        currentPending.value = false;
        if (e.status !== 409) review.value = undefined;
      }
    }
    return;
  } finally {
    busy.value = false;
  }
  await load();
}
watch(
  () => route.fullPath,
  () => {
    if (route.params.id && completed?.id !== route.params.id) notice.value = '';
    completed = undefined;
    reason.value = '';
    void loadQueue();
    return load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="page-heading">
    <h1>活动审核</h1>
    <label v-if="!route.params.id" class="review-filter"
      >审核状态
      <UiSelect
        label="审核状态"
        :model-value="status"
        :options="[
          { value: 'pending', label: '待审' },
          { value: 'approved', label: '已批准' },
          { value: 'rejected', label: '已驳回' },
        ]"
        @update:model-value="
          savedScroll = 0;
          router.push({ path: '/reviews', query: { status: $event, page: 1 } });
        "
      />
    </label>
    <RouterLink
      v-else
      class="button"
      :to="scheduleReturn() || { path: '/reviews', query: route.query }"
      ><UiIcon name="ArrowLeft" />{{ scheduleReturn() ? '返回日程' : '返回审核队列' }}</RouterLink
    >
  </div>
  <p v-if="notice" role="status" class="notice">{{ notice }}</p>
  <p v-if="error" role="alert">{{ error }} <button @click="load">刷新</button></p>
  <p v-if="loading" role="status">正在读取…</p>
  <RecordWorkspace :selected="!!route.params.id">
    <template #list>
      <p v-if="queueError" role="alert">
        {{ queueError }} <button @click="loadQueue">重新读取队列</button>
      </p>
      <p v-else-if="queueLoading" role="status">正在读取审核队列…</p>
      <div v-else-if="rows.length" class="entry-list reading-area">
        <RouterLink
          v-for="r in rows"
          :key="r.id"
          :aria-current="route.params.id === r.id ? 'true' : undefined"
          :to="{ path: '/reviews/' + r.id, query: route.query }"
          @click="savedScroll = windowScroll()"
        >
          <span class="item-icon"><UiIcon name="DocumentChecked" /></span>
          <div>
            <strong>{{ r.snapshot.content.title }} · 版本 {{ r.revision }}</strong
            ><small v-if="r.created_at">送审 {{ localDateTime(r.created_at) }}</small>
          </div>
          <span class="row-end"
            ><span class="state-chip" :class="{ attention: r.status === 'pending' }">{{
              reviewLabels[r.status]
            }}</span
            ><UiIcon name="ArrowRight"
          /></span>
        </RouterLink>
      </div>
      <div v-else class="empty-state">
        <UiIcon name="CircleCheck" />
        <p>暂无匹配的审核</p>
      </div>
      <Pager
        v-if="total > 20 && !queueError && !queueLoading"
        :page="page"
        :size="20"
        :total="total"
        @change="(p) => router.push({ path: '/reviews', query: { ...route.query, page: p } })"
      />
    </template>
    <template #detail>
      <article v-if="review" class="review-detail">
        <div class="page-title">
          <h2>{{ review.snapshot.content.title }} · 送审版本 {{ review.revision }}</h2>
          <span class="state-chip" :class="{ attention: review.status === 'pending' }">{{
            reviewLabels[review.status]
          }}</span>
        </div>
        <p class="meta-line">
          {{
            review.previous_published_snapshot
              ? '原公开版本 ' + review.previous_published_snapshot.revision
              : '首次发布，尚无公开版本'
          }}
        </p>
        <section v-if="review.previous_published_snapshot" class="diff">
          <h3>逐字段差异</h3>
          <dl v-if="review.changes.length">
            <template v-for="c in review.changes" :key="c.field_path"
              ><dt>{{ fieldLabel(c.field_path) }}</dt>
              <dd>
                <span>{{ fieldValue(c.field_path, JSON.parse(c.before_value)) }}</span> →
                <strong>{{ fieldValue(c.field_path, JSON.parse(c.after_value)) }}</strong>
              </dd>
            </template>
          </dl>
          <p v-else>与原公开版本一致</p>
        </section>
        <details :open="!review.previous_published_snapshot">
          <summary>冻结内容</summary>
          <ActivitySnapshot :content="review.snapshot.content" />
        </details>
        <details v-if="review.previous_published_snapshot">
          <summary>原公开内容</summary>
          <ActivitySnapshot :content="review.previous_published_snapshot.content" />
        </details>
        <form v-if="canDecide" class="decision-form" @submit.prevent="decide('approved')">
          <label>审核意见（驳回必填）<textarea v-model="reason" rows="2" /></label>
          <div class="page-actions">
            <button type="button" :disabled="busy" @click="decide('rejected')">驳回</button>
            <button class="primary" type="submit" :disabled="busy">
              <UiIcon name="Check" />批准发布
            </button>
          </div>
        </form>
        <p v-else class="notice">
          当前审核只读 · {{ reviewLabels[review.status] }} {{ review.reason }}
        </p>
      </article>
    </template>
  </RecordWorkspace>
</template>
<style scoped>
.review-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--muted);
}
.entry-list a[aria-current] {
  background: var(--brand-tint);
  box-shadow: inset 3px 0 var(--brand);
}
.entry-list small {
  display: block;
  color: var(--muted);
  font-size: 13px;
}
.review-detail > .meta-line {
  margin: 8px 0 20px;
}
.review-detail details {
  border-top: 1px solid var(--line);
  padding-block: 10px;
}
.review-detail summary {
  display: list-item;
  align-content: center;
  padding: 4px 0;
}
.diff {
  padding: 16px;
  background: var(--surface);
  border-radius: var(--radius);
  margin-bottom: 18px;
}
.diff dl {
  margin: 8px 0 0;
  font-size: 14px;
  grid-template-columns: minmax(6em, 20%) minmax(0, 1fr);
}
.diff dd {
  white-space: pre-line;
}
.diff dd span {
  color: var(--muted);
}
.diff dd strong {
  color: var(--brand);
  font-weight: 550;
}
.decision-form {
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.decision-form label {
  display: grid;
  gap: 6px;
}
.decision-form .page-actions {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
