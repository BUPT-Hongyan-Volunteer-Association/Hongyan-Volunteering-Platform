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
import RecordSummaryList from '@hongyan/ui/RecordSummaryList.vue';
import RecordWorkspace from '@hongyan/ui/RecordWorkspace.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { message, noAccess, pageNumber, usePageRead } from '@hongyan/ui/usePageRead';

const route = useRoute(),
  router = useRouter();
const page = computed(() => pageNumber(route.query.page));
const range = computed(() =>
  route.query.pending === '1' ? 'pending' : route.query.read === 'unread' ? 'unread' : 'all',
);
const scopes = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'pending', label: '待确认' },
] as const;
const search = computed({
  get: () => String(route.query.search || ''),
  set: (value: string) =>
    router.replace({
      path: '/notices',
      query: { ...route.query, search: value || undefined, page: undefined },
    }),
});
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
  other: '活动通知',
};
const readCommand = createCommand(),
  ackCommand = createCommand();
const busy = ref(false),
  feedback = ref('');
watch(
  () => route.fullPath,
  () => {
    feedback.value = '';
  },
);
const {
  data: listing,
  error: listError,
  loading: listLoading,
  refresh: refreshList,
} = usePageRead(
  () => JSON.stringify([activity.value, page.value, search.value, range.value]),
  async (signal) => {
    const filter = range.value, q = search.value.trim();
    const { data } = await listMyNotices({
      query: {
        activity_id: activity.value, page: page.value, page_size: 10, q: q || undefined,
        unread_only: filter === 'unread' || undefined,
        unacknowledged_only: filter === 'pending' || undefined,
        with_counts: true,
      },
      signal, throwOnError: true,
    });
    return { ...data.data, filter, q };
  },
  undefined, { keepPrevious: true },
);
const {
  data: detail,
  error: detailError,
  refresh: refreshDetail,
} = usePageRead(item, async (signal) => {
  const id = item.value;
  if (!id) return;
  const { data } = await listMyNotices({ query: { notice_id: id }, signal, throwOnError: true });
  let notice = data.data.items[0];
  if (notice && !notice.read_at && !signal.aborted) {
    try {
      const read = await readNotice({
        path: { id },
        headers: readCommand.headers('read_notice', id, {}),
        signal,
        throwOnError: true,
      });
      window.dispatchEvent(new Event('hongyan-notice-updated'));
      if (!signal.aborted) {
        readCommand.confirmed();
        notice = read.data.data;
      }
    } catch (e) {
      if (!signal.aborted) {
        if (noAccess(e)) throw e;
        feedback.value = message(e);
      }
    }
  }
  return { notice };
});
const selected = computed(() => detail.value?.notice);
function state(notice: Notice) {
  if (!notice.is_current) return { label: '已被替代', tone: 'mute' };
  if (notice.acknowledged_at) return { label: '已确认', tone: 'done' };
  if (notice.read_at) return { label: notice.requires_ack ? '已读未确认' : '已读', tone: 'wait' };
  return { label: '未读', tone: 'new' };
}
async function ack(notice: Notice) {
  if (busy.value) return;
  const origin = route.fullPath;
  busy.value = true;
  feedback.value = '';
  try {
    await acknowledgeNotice({
      path: { id: notice.id },
      headers: ackCommand.headers('acknowledge_notice', notice.id, {}),
      throwOnError: true,
    });
    ackCommand.confirmed();
    window.dispatchEvent(new Event('hongyan-notice-updated'));
    if (route.fullPath === origin) {
      feedback.value = '已确认收到，负责人可在回执里看到。';
      if (item.value === notice.id) await refreshDetail(false);
    }
  } catch (e) {
    if (route.fullPath === origin) {
      feedback.value = message(e);
      if (noAccess(e) || (e instanceof ApiError && e.status === 409)) {
        await refreshList();
        if (item.value === notice.id) await refreshDetail();
      }
    }
  } finally {
    busy.value = false;
  }
}
const rows = computed(() =>
  (listing.value?.items || []).map((notice) => ({
    id: notice.id,
    title: notice.title,
    context: kinds[notice.notice_kind] + ' · 第 ' + notice.information_version + ' 版',
    status: state(notice).label,
    summary: notice.body,
    date: notice.published_at,
    dateLabel: localDateTime(notice.published_at),
    unread: !notice.read_at,
    notice,
  })),
);
const focus = () => {
  void refreshList(false);
  if (item.value) void refreshDetail(false);
};
const reloadInbox = () => void refreshList(false);
onMounted(() => {
  window.addEventListener('focus', focus);
  window.addEventListener('hongyan-inbox-changed', reloadInbox);
  window.addEventListener('hongyan-notice-updated', reloadInbox);
});
onUnmounted(() => {
  window.removeEventListener('focus', focus);
  window.removeEventListener('hongyan-inbox-changed', reloadInbox);
  window.removeEventListener('hongyan-notice-updated', reloadInbox);
});
</script>

<template>
  <section :class="{ 'reading-area': !item }">
    <h1>通知</h1>
    <RecordWorkspace :selected="!!item">
      <template #list>
        <div class="inbox-tools">
          <nav class="section-nav" aria-label="通知筛选">
            <RouterLink
              v-for="scope in scopes"
              :key="scope.key"
              active-class=""
              exact-active-class=""
              :class="{ current: range === scope.key }"
              :aria-current="range === scope.key ? 'true' : 'false'"
              :to="{
                path: '/notices',
                query: {
                  ...route.query,
                  page: undefined,
                  pending: scope.key === 'pending' ? '1' : undefined,
                  read: scope.key === 'unread' ? 'unread' : undefined,
                },
              }"
            >
              {{ scope.label
              }}<span v-if="listing?.inbox_counts"> {{ listing.inbox_counts[scope.key] }}</span>
            </RouterLink>
          </nav>
          <label class="search-field"
            ><UiIcon name="Search" /><span class="sr-only">搜索通知</span>
            <input v-model="search" type="search" maxlength="100" placeholder="搜索标题或正文" />
          </label>
        </div>
        <p v-if="listError" role="alert">
          {{ listError }} <button @click="refreshList()">重新读取</button>
        </p>
        <p v-else-if="!listing" role="status">正在读取通知…</p>
        <div v-else :aria-busy="listLoading" :inert="listLoading">
          <div v-if="item && rows.length" class="entry-list notice-queue">
            <RouterLink
              v-for="row in rows"
              :key="row.id"
              :aria-current="row.id === item ? 'true' : undefined"
              :to="{ path: '/notices/' + row.id, query: route.query }"
            >
              <strong>{{ row.title }}</strong
              ><span class="state-chip neutral">{{ row.status }}</span>
            </RouterLink>
          </div>
          <RecordSummaryList v-else-if="rows.length" :records="rows">
            <template #title="{ row }">
              <RouterLink :to="{ path: '/notices/' + row.id, query: route.query }">{{
                row.title
              }}</RouterLink>
            </template>
            <template #action="{ row }">
              <div
                v-if="row.notice.requires_ack && row.notice.is_current && !row.notice.acknowledged_at"
                class="confirm-action"
              >
                <button class="compact" :disabled="busy" @click="ack(row.notice)">确认收到</button>
              </div>
            </template>
          </RecordSummaryList>
          <p v-else role="status">
            {{
              listing.q
                ? '暂无匹配通知。'
                : listing.filter === 'pending'
                  ? '没有待确认的通知。'
                  : listing.filter === 'unread'
                    ? '没有未读通知。'
                    : '暂时没有通知。'
            }}
          </p>
          <Pager
            v-if="page > 1 || listing.total > listing.page_size"
            :page="page"
            :size="listing.page_size"
            :total="listing.total"
            @change="(n) => router.push({ path: '/notices', query: { ...route.query, page: n } })"
          />
        </div>
      </template>
      <template #detail>
        <RouterLink class="back-link" :to="{ path: '/notices', query: route.query }"
          ><UiIcon name="ArrowLeft" />返回通知</RouterLink
        >
        <p v-if="detailError" role="alert">
          {{ detailError }} <button @click="refreshDetail()">重新读取</button>
        </p>
        <p v-else-if="!detail" role="status">正在读取通知详情…</p>
        <section v-else-if="selected" class="notice-detail">
          <h2>{{ selected.title }}</h2>
          <div class="meta-line">
            {{ localDateTime(selected.published_at) }} 发布 · 第
            {{ selected.information_version }} 版
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
            <button v-if="!selected.read_at" :disabled="busy" @click="refreshDetail()">
              标记已读
            </button>
          </div>
          <p v-if="!selected.is_current" class="hint">
            这条通知已被同一活动的后续版本替代，可在列表查看最新通知。
          </p>
        </section>
        <p v-else>
          未找到可查看的通知。
          <RouterLink to="/notices">回到通知列表</RouterLink>
        </p>
      </template>
    </RecordWorkspace>
    <p v-if="feedback" role="status">{{ feedback }}</p>
  </section>
</template>

<style scoped>
.confirm-action { display: flex; justify-content: center; flex-basis: 100%; margin-block: 8px; }
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
  justify-content: center;
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
.state-chip[data-tone='wait'] {
  color: #8a5a00;
}
.hint {
  color: var(--text-muted, #666);
  margin-top: 12px;
}
.inbox-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0 0 12px;
}
.inbox-tools .section-nav {
  margin: 0;
  border: 0;
}
.inbox-tools .section-nav a {
  gap: 4px;
}
.inbox-tools .search-field {
  width: min(100%, 220px);
}
.notice-queue a {
  flex-wrap: wrap;
}
.notice-queue a[aria-current] {
  background: var(--brand-tint);
  box-shadow: inset 3px 0 var(--brand);
}
</style>
