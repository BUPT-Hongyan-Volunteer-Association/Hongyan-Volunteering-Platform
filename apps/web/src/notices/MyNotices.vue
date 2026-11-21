<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  acknowledgeNotice,
  ApiError,
  createCommand,
  listMyNotices,
  readNotice,
  type Notice,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { message, pageNumber, usePageRead } from '../usePageRead';

const route = useRoute(),
  router = useRouter();
const page = computed(() => pageNumber(route.query.page));
const pendingOnly = computed(() => route.query.pending === '1');
const item = computed(() => String(route.params.item || ''));
const activity = computed(() =>
  typeof route.query.activity_id === 'string' ? route.query.activity_id : undefined,
);
const kinds: Record<Notice['notice_kind'], string> = {
  result: '报名结果',
  change: '活动信息变更',
  gathering: '集合通知',
  cancellation: '活动取消',
  hours_result: '时长结果',
  appeal_result: '申诉结果',
  other: '其他',
};
const readCommand = createCommand(),
  ackCommand = createCommand();
const busy = ref(false),
  feedback = ref('');
watch(item, () => {
  feedback.value = '';
});
const {
  data: result,
  error,
  refresh,
} = usePageRead(
  () => route.fullPath,
  async (signal) => {
    const id = item.value;
    const query = id
      ? { notice_id: id }
      : {
          activity_id: activity.value,
          page: page.value,
          page_size: 10,
          unacknowledged_only: pendingOnly.value || undefined,
        };
    const [rows, count] = await Promise.all([
      listMyNotices({ query, signal, throwOnError: true }),
      !id && !pendingOnly.value
        ? listMyNotices({
            query: { activity_id: activity.value, unacknowledged_only: true, page_size: 1 },
            signal,
            throwOnError: true,
          })
        : undefined,
    ]);
    let detail = id ? rows.data.data.items[0] : undefined;
    if (detail && !detail.read_at && !signal.aborted) {
      try {
        const read = await readNotice({
          path: { id },
          headers: readCommand.headers('read_notice', id, {}),
          signal,
          throwOnError: true,
        });
        if (!signal.aborted) {
          readCommand.confirmed();
          detail = read.data.data;
        }
      } catch (e) {
        if (!signal.aborted) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0)) throw e;
          feedback.value = message(e);
        }
      }
    }
    return {
      page: rows.data.data,
      detail,
      pendingCount: count?.data.data.total ?? rows.data.data.total,
    };
  },
);
const selected = computed(() => result.value?.detail);
function state(notice: Notice) {
  if (!notice.is_current) return { label: '已被替代', tone: 'mute' };
  if (notice.acknowledged_at) return { label: '已确认', tone: 'done' };
  if (notice.read_at) return { label: notice.requires_ack ? '已读未确认' : '已读', tone: 'wait' };
  return { label: '未读', tone: 'new' };
}
async function ack(notice: Notice) {
  if (busy.value) return;
  busy.value = true;
  feedback.value = '';
  try {
    await acknowledgeNotice({
      path: { id: notice.id },
      headers: ackCommand.headers('acknowledge_notice', notice.id, {}),
      throwOnError: true,
    });
    ackCommand.confirmed();
    if (item.value === notice.id) {
      feedback.value = '已确认收到，负责人可在回执里看到。';
      await refresh(false);
    }
  } catch (e) {
    if (item.value === notice.id) {
      feedback.value = message(e);
      if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status ?? 0)) await refresh();
    }
  } finally {
    busy.value = false;
  }
}
function filter(pending: string) {
  void router.push({
    path: '/notices',
    query: { activity_id: activity.value, pending: pending === '1' ? '1' : undefined },
  });
}
const focus = () => void refresh(false);
onMounted(() => window.addEventListener('focus', focus));
onUnmounted(() => window.removeEventListener('focus', focus));
</script>

<template>
  <RouterLink v-if="item" class="back-link" :to="{ path: '/notices', query: route.query }">
    <UiIcon name="ArrowLeft" />返回通知
  </RouterLink>
  <header class="page-heading">
    <h1>
      {{ item ? '通知详情' : '通知' }}
      <span v-if="!item && result?.pendingCount" class="pending-badge"
        >待确认 {{ result?.pendingCount }}</span
      >
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

  <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重新读取</button></p>
  <p v-else-if="!result" role="status">正在读取通知…</p>

  <template v-else-if="item">
    <section v-if="selected" class="notice-detail">
      <h2>{{ selected.title }}</h2>
      <div class="meta-line">
        {{ localDateTime(selected.published_at) }} 发布 · 第 {{ selected.information_version }} 版
        <span class="state-chip" :data-tone="state(selected).tone">{{
          state(selected).label
        }}</span>
      </div>
      <p class="notice-body">{{ selected.body }}</p>
      <dl class="detail-fields">
        <dt>通知类型</dt>
        <dd>{{ kinds[selected.notice_kind] }}</dd>
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
          :to="{
            path: '/activities/' + selected.activity_id,
            state: { noticeReturn: route.fullPath },
          }"
          >查看活动详情</RouterLink
        >
        <button v-if="!selected.read_at" :disabled="busy" @click="refresh()">标记已读</button>
      </div>
      <p v-if="!selected.is_current" class="hint">
        这条通知已被同一活动的后续版本替代，可在列表查看最新通知。
      </p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
    </section>
    <p v-else>
      未找到可查看的通知。
      <RouterLink to="/notices">回到通知列表</RouterLink>
    </p>
  </template>

  <template v-else>
    <div v-if="result.page.items.length" class="entry-list">
      <RouterLink
        v-for="row in result.page.items"
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
      :size="result.page.page_size"
      :total="result.page.total"
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
