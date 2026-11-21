<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  acknowledgeNotice,
  createCommand,
  listMyNotices,
  readNotice,
  type Notice,
  type NoticePage,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';

const route = useRoute();
const router = useRouter();
const page = computed(() => {
  const value = Number(route.query.page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const pendingOnly = computed(() => route.query.pending === '1');
const item = computed(() => String(route.params.item || ''));

const result = ref<NoticePage>();
const selected = ref<Notice>();
const error = ref('');
const pendingCount = ref<number>();
const busy = ref(false);
const feedback = ref('');
const command = createCommand();
let serial = 0;

const paid = computed(
  () => (selected.value?.information_version ?? 0) > 0 && selected.value?.is_current === false,
);
function state(notice: Notice) {
  if (!notice.is_current) return { label: '已被替代', tone: 'mute' };
  if (notice.acknowledged_at) return { label: '已确认', tone: 'done' };
  if (notice.read_at) return { label: '已读未确认', tone: 'wait' };
  return { label: '未读', tone: 'new' };
}

async function load() {
  const turn = ++serial;
  error.value = '';
  const keep = selected.value;
  result.value = undefined;
  try {
    if (item.value) {
      // 列表接口不支持按 id 取单条，这里逐页查找（上限 10 页，够 500 条通知）。
      for (let index = 1; index <= 10; index += 1) {
        const { data } = await listMyNotices({
          query: { page: index, page_size: 50 },
          throwOnError: true,
        });
        if (turn !== serial) return;
        result.value = data.data;
        const found = data.data.items.find((row) => row.id === item.value);
        if (found) {
          selected.value = found;
          break;
        }
        if (index * data.data.page_size >= data.data.total) break;
      }
      selected.value ??= keep;
      if (selected.value && !selected.value.read_at) await markRead(selected.value);
      return;
    }
    const [{ data }, counted] = await Promise.all([
      listMyNotices({
        query: {
          page: page.value,
          page_size: 10,
          unacknowledged_only: pendingOnly.value || undefined,
        },
        throwOnError: true,
      }),
      pendingOnly.value
        ? Promise.resolve(undefined)
        : listMyNotices({ query: { page_size: 1, unacknowledged_only: true }, throwOnError: true }),
    ]);
    if (turn !== serial) return;
    result.value = data.data;
    pendingCount.value = pendingOnly.value ? data.data.total : counted?.data.data.total;
  } catch (e) {
    if (turn === serial) error.value = e instanceof Error ? e.message : '通知读取失败';
  }
}

async function markRead(notice: Notice) {
  const body = {};
  try {
    const { data } = await readNotice({
      path: { id: notice.id },
      headers: command.headers('read_notice', notice.id, body),
      throwOnError: true,
    });
    command.confirmed();
    if (selected.value?.id === notice.id) selected.value = data.data;
  } catch (e) {
    feedback.value = e instanceof Error ? e.message : '标记已读失败';
  }
}

async function ack(notice: Notice) {
  if (busy.value || !notice.requires_ack) return;
  busy.value = true;
  feedback.value = '';
  try {
    const body = {};
    const { data } = await acknowledgeNotice({
      path: { id: notice.id },
      headers: command.headers('acknowledge_notice', notice.id, body),
      throwOnError: true,
    });
    command.confirmed();
    selected.value = data.data;
    feedback.value = '已确认收到，负责人可在回执里看到。';
  } catch (e) {
    feedback.value = e instanceof Error ? e.message : '确认失败';
  } finally {
    busy.value = false;
  }
}

function filter(pending: string) {
  void router.push({ path: '/notices', query: pending === '1' ? { pending: '1' } : {} });
}

watch(() => route.fullPath, load, { immediate: true });
onMounted(() => window.addEventListener('focus', load));
onUnmounted(() => {
  serial++;
  window.removeEventListener('focus', load);
});
</script>

<template>
  <RouterLink v-if="item" class="back-link" :to="{ path: '/notices', query: route.query }">
    <UiIcon name="ArrowLeft" />返回通知
  </RouterLink>
  <header class="page-heading">
    <h1>
      {{ item ? '通知详情' : '通知' }}
      <span v-if="!item && pendingCount" class="pending-badge">待确认 {{ pendingCount }}</span>
    </h1>
    <UiSelect
      v-if="!item"
      label="通知范围"
      :model-value="pendingOnly ? '1' : '0'"
      :options="[
        { value: '0', label: '全部通知' },
        { value: '1', label: '只看待确认' },
      ]"
      @update:model-value="filter"
    />
  </header>

  <p v-if="error" role="alert">{{ error }} <button @click="load">重新读取</button></p>
  <p v-else-if="!result" role="status">正在读取通知…</p>

  <template v-else-if="item">
    <section v-if="selected" class="notice-detail">
      <h2>{{ selected.title }}</h2>
      <div class="meta-line">
        {{ localDateTime(selected.published_at) }} 发布 · 第 {{ selected.information_version }} 版
        <span class="state-chip" :data-tone="state(selected).tone">{{ state(selected).label }}</span>
        <span v-if="paid" class="state-chip">已被替代</span>
      </div>
      <p class="notice-body">{{ selected.body }}</p>
      <dl class="detail-fields">
        <dt>通知类型</dt>
        <dd>{{ selected.notice_kind === 'result' ? '报名结果' : '活动信息变更' }}</dd>
        <dt>是否需要确认</dt>
        <dd>{{ selected.requires_ack ? '需要' : '不需要' }}</dd>
        <dt>当前状态</dt>
        <dd>{{ state(selected).label }}</dd>
        <template v-if="selected.read_at"
          ><dt>已读时间</dt>
          <dd>{{ localDateTime(selected.read_at) }}</dd></template
        >
        <template v-if="selected.acknowledged_at"
          ><dt>确认时间</dt>
          <dd>{{ localDateTime(selected.acknowledged_at) }}</dd></template
        >
      </dl>
      <div class="row-actions">
        <button
          v-if="selected.requires_ack && !selected.acknowledged_at && selected.is_current"
          class="primary"
          :disabled="busy"
          @click="ack(selected)"
        >
          确认收到
        </button>
        <RouterLink
          class="button"
          :to="{ path: '/activities/' + selected.activity_id, state: { noticeReturn: route.fullPath } }"
          >查看活动详情</RouterLink
        >
        <button v-if="!selected.read_at" :disabled="busy" @click="markRead(selected)">
          标记已读
        </button>
      </div>
      <p v-if="paid" class="hint">
        这条通知已被同一活动的后续版本替代，仅作为历史记录保留；请以最新一条为准。
      </p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
    </section>
    <p v-else>
      未找到该通知，可能已被后续版本替代或已不可见。
      <RouterLink to="/notices">回到通知列表</RouterLink>
    </p>
  </template>

  <template v-else>
    <div v-if="result.items.length" class="entry-list">
      <RouterLink
        v-for="row in result.items"
        :key="row.id"
        :class="{ superseded: !row.is_current }"
        :to="{ path: '/notices/' + row.id, query: route.query }"
      >
        <div>
          <strong>{{ row.title }}</strong>
          <div class="meta-line">
            {{ localDateTime(row.published_at) }} 发布 · 第 {{ row.information_version }} 版
          </div>
        </div>
        <span class="state-chip" :data-tone="state(row).tone">{{ state(row).label }}</span>
      </RouterLink>
    </div>
    <p v-else>{{ pendingOnly ? '没有待确认的通知。' : '暂时没有通知。' }}</p>
    <Pager
      :page="page"
      :size="result.page_size"
      :total="result.total"
      @change="(n) => router.push({ query: { ...route.query, page: n } })"
    />
  </template>
</template>

<style scoped>
.notice-body {
  white-space: pre-line;
  line-height: 1.8;
  margin: 16px 0;
  /* 通知正文可能带长链接或长编号，必须允许在任意位置断行，否则会撑破页面。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}
.row-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.state-chip[data-tone='done'] {
  color: #1f7a3d;
}
.state-chip[data-tone='new'] {
  color: #1d4ed8;
}
.state-chip[data-tone='mute'] {
  color: #8a8f99;
}
.entry-list a.superseded {
  opacity: 0.72;
}
.state-chip[data-tone='wait'] {
  color: #8a5a00;
}
.hint {
  color: var(--text-muted, #666);
  margin-top: 12px;
}
.pending-badge {
  font-size: 13px;
  font-weight: 500;
  margin-left: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff3e0;
  color: #8a5a00;
}
</style>
