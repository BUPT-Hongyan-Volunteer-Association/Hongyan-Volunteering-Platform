<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  getActivityReview,
  getManagedActivity,
  getProfile,
  listActivityReviews,
  reviewActivity,
  writeHeaders,
  type ActivityReview,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
const route = useRoute(),
  router = useRouter(),
  review = ref<ActivityReview>(),
  rows = ref<ActivityReview[]>([]),
  total = ref(0),
  busy = ref(false),
  loading = ref(false),
  canDecide = ref(false),
  reason = ref(''),
  error = ref(''),
  notice = ref('');
const status = computed(
  () => String(route.query.status || 'pending') as 'pending' | 'approved' | 'rejected',
);
const page = computed(() => Number(route.query.page || 1));
const labels: Record<string, string> = {
  title: '活动标题',
  description: '服务内容',
  beneficiaries: '服务对象',
  schedule: '活动安排',
  starts_at: '开始时间',
  ends_at: '结束时间',
  schedule_type: '时间类型',
  location: '活动地点',
  meeting_point: '集合地点',
  campus: '校区',
  transport_notes: '交通说明',
  capacity: '计划名额',
  registration_opens_at: '报名开放',
  registration_closes_at: '报名截止',
  result_expected_at: '预计结果公布',
  eligibility_text: '报名条件',
  selection_text: '录取说明',
  group_join_instructions: '入群方式',
  hours_rule_text: '时长认定',
  hours_import_expected_at: '预计导入时间',
  contact_text: '联系渠道',
  expected_hours: '预计时长',
  expected_hours_basis: '时长口径',
  safety_notes: '安全说明',
};
const label = (k: string) =>
  k
    .split('.')
    .map((f) => labels[f] ?? f)
    .join(' / ');
function display(value: unknown): string {
  if (value == null) return '无';
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([k, v]) => label(k) + ' ' + display(v))
      .join('，');
  return String(value);
}
const windowScroll = () => window.scrollY;
let serial = 0,
  savedScroll = 0,
  last = { signature: '', key: '' };
async function load() {
  const n = ++serial;
  loading.value = true;
  error.value = '';
  rows.value = [];
  review.value = undefined;
  canDecide.value = false;
  reason.value = '';
  try {
    if (route.params.id) {
      const r = (
        await getActivityReview({ path: { id: String(route.params.id) }, throwOnError: true })
      ).data.data;
      const [managed, profile] = await Promise.all([
        getManagedActivity({ path: { id: r.activity_id }, throwOnError: true }),
        getProfile({ throwOnError: true }),
      ]);
      if (n !== serial) return;
      review.value = r;
      canDecide.value =
        r.status === 'pending' &&
        managed.data.data.current_review?.id === r.id &&
        ['pending_review', 'published'].includes(managed.data.data.activity.status) &&
        profile.data.data.account_id !== r.submitted_by;
    } else {
      const result = (
        await listActivityReviews({
          query: { status: status.value, page: page.value },
          throwOnError: true,
        })
      ).data.data;
      if (n !== serial) return;
      rows.value = result.items;
      total.value = result.total;
    }
  } catch (e) {
    if (n === serial) error.value = e instanceof Error ? e.message : '读取失败';
  } finally {
    if (n === serial) {
      loading.value = false;
      if (!route.params.id) {
        await nextTick();
        window.scrollTo(0, savedScroll);
      }
    }
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
  const signature = JSON.stringify([id, body]);
  if (last.signature !== signature) last = { signature, key: crypto.randomUUID() };
  try {
    await reviewActivity({
      path: { id },
      headers: { ...writeHeaders(), 'Idempotency-Key': last.key },
      body,
      throwOnError: true,
    });
    canDecide.value = false;
    await getManagedActivity({ path: { id: review.value.activity_id }, throwOnError: true });
    notice.value = (decision === 'approved' ? '已批准' : '已驳回') + '，审核队列已更新';
    await router.push({ path: '/reviews', query: route.query });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '提交失败';
    if (e instanceof ApiError && [403, 404, 409].includes(e.status ?? 0)) await load();
    error.value = msg;
  } finally {
    busy.value = false;
  }
}
watch(() => route.fullPath, load, { immediate: true });
</script>
<template>
  <h1>活动审核</h1>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="error" role="alert">{{ error }} <button @click="load">刷新</button></p>
  <p v-if="loading">正在读取…</p>
  <template v-else-if="!route.params.id">
    <label
      >审核状态
      <select
        :value="status"
        @change="
          savedScroll = 0;
          router.push({ query: { status: ($event.target as HTMLSelectElement).value, page: 1 } });
        "
      >
        <option value="pending">待审</option>
        <option value="approved">已批准</option>
        <option value="rejected">已驳回</option>
      </select></label
    >
    <ul>
      <li v-for="r in rows" :key="r.id">
        <RouterLink
          :to="{ path: '/reviews/' + r.id, query: route.query }"
          @click="savedScroll = windowScroll()"
          >{{ r.snapshot.content.title }} · 版本 {{ r.revision }}</RouterLink
        >
      </li>
    </ul>
    <p v-if="!rows.length && !error">暂无匹配的审核</p>
    <Pager
      :page="page"
      :size="20"
      :total="total"
      @change="(p) => router.push({ query: { ...route.query, page: p } })"
  /></template>
  <template v-else
    ><RouterLink :to="{ path: '/reviews', query: route.query }">返回审核队列</RouterLink>
    <article v-if="review">
      <h2>{{ review.snapshot.content.title }} · 送审版本 {{ review.revision }}</h2>
      <p>
        {{
          review.previous_published_snapshot
            ? '原公开版本 ' + review.previous_published_snapshot.revision
            : '首次发布，尚无公开版本'
        }}
      </p>
      <details open>
        <summary>冻结内容</summary>
        <dl>
          <template v-for="(value, k) in review.snapshot.content"
            ><dt>{{ label(String(k)) }}</dt>
            <dd>{{ display(value) }}</dd></template
          >
        </dl>
      </details>
      <template v-if="review.previous_published_snapshot"
        ><details>
          <summary>原公开内容</summary>
          <dl>
            <template v-for="(value, k) in review.previous_published_snapshot.content"
              ><dt>{{ label(String(k)) }}</dt>
              <dd>{{ display(value) }}</dd></template
            >
          </dl>
        </details>
        <h3>逐字段差异</h3>
        <ul>
          <li v-for="c in review.changes" :key="c.field_path">
            {{ label(c.field_path) }}：{{ display(JSON.parse(c.before_value)) }} →
            {{ display(JSON.parse(c.after_value)) }}
          </li>
        </ul></template
      >
      <template v-if="canDecide"
        ><label>审核意见（驳回必填）<input v-model="reason" /></label>
        <button :disabled="busy" @click="decide('approved')">批准发布</button>
        <button :disabled="busy" @click="decide('rejected')">驳回</button></template
      >
      <p v-else>当前审核只读 · {{ review.status }} {{ review.reason }}</p>
    </article></template
  >
</template>
