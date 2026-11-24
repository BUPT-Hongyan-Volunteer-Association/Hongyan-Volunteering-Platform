<script setup lang="ts">
import { computed } from 'vue';
import PublishNotice from './PublishNotice.vue';
import { useRoute, useRouter } from 'vue-router';
import { listActivityNotices, listNoticeReceipts, type ExportInput } from '@hongyan/contracts';
import RecordWorkspace from '@hongyan/ui/RecordWorkspace.vue';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import ExportButton from '@hongyan/ui/ExportButton.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';

defineProps<{ writesPaused?: boolean }>();
const emit = defineEmits<{ denied: [] }>();
const route = useRoute(),
  router = useRouter();
const activityId = computed(() => String(route.params.id));
const item = computed(() => String(route.params.item || ''));
const page = computed(() => pageNumber(route.query.notice_page));
const receiptIndex = computed(() => pageNumber(route.query.receipt_page));
const listQuery = computed(() => ({
  page: route.query.page,
  notice_page: route.query.notice_page,
}));
const listPath = computed(() => '/managed/' + activityId.value + '/notices');
const compose = computed(() => !item.value && route.query.compose === '1');

const {
  data: listing,
  error,
  refresh,
} = usePageRead(
  () => compose.value ? '' : [activityId.value, item.value, page.value].join('/'),
  async (signal) => {
    if (compose.value) return;
    const path = { id: activityId.value },
      id = item.value;
    const { data } = await listActivityNotices({
      path,
      query: { page: page.value, page_size: 10 },
      signal,
      throwOnError: true,
    });
    let selected = data.data.items.find((n) => n.id === id);
    if (id && !selected) {
      selected = (
        await listActivityNotices({
          path,
          query: { notice_id: id },
          signal,
          throwOnError: true,
        })
      ).data.data.items[0];
    }
    return { page: data.data, selected };
  },
);
const current = computed(() => listing.value?.selected);
const followUp = computed({
  get: () => (route.query.receipts === 'all' || (!route.query.receipts && !current.value?.requires_ack) ? '0' : '1'),
  set: (value) => {
    void router.push({
      query: { ...listQuery.value, receipts: value === '0' ? 'all' : 'pending' },
    });
  },
});
const {
  data: receiptPage,
  loading,
  error: receiptError,
  refresh: refreshReceipts,
} = usePageRead(
  () => [current.value?.id, receiptIndex.value, followUp.value].join('/'),
  async (signal) => {
    const notice = current.value;
    if (!notice) return;
    const path = { id: notice.id },
      pending = followUp.value === '1';
    const [rows, count] = await Promise.all([
      listNoticeReceipts({
        path,
        query: { page: receiptIndex.value, page_size: 20, follow_up_only: pending },
        signal,
        throwOnError: true,
      }),
      !pending && notice.is_current && notice.requires_ack
        ? listNoticeReceipts({
            path,
            query: { page_size: 1, follow_up_only: true },
            signal,
            throwOnError: true,
          })
        : undefined,
    ]);
    return {
      rows: rows.data.data,
      pending: pending ? rows.data.data.total : (count?.data.data.total ?? 0),
    };
  },
  () => void refresh(),
);
const receipts = computed(() => receiptPage.value?.rows);
const receiptExportInput = computed<ExportInput>(() => ({
  type: 'notice_receipts',
  notice_id: current.value?.id ?? '',
  follow_up_only: followUp.value === '1',
}));
async function reloadReceipts() {
  await refresh(false);
  if (current.value) await refreshReceipts();
}
</script>

<template>
  <section :class="{ 'reading-area': !item }">
    <div class="page-heading">
      <h2>通知与回执</h2>
      <RouterLink v-if="!compose" class="button primary" :to="{ path: listPath, query: { ...listQuery, compose: '1' } }">发布通知</RouterLink>
    </div>
    <PublishNotice v-if="compose" :activity-id="activityId" :writes-paused="writesPaused"
      @published="(id) => router.replace({ path: listPath + '/' + id, query: { page: route.query.page } })"
      @cancel="router.replace({ path: listPath, query: listQuery })" @denied="emit('denied')" />
    <p v-else-if="error" role="alert">{{ error }} <button @click="refresh()">重新读取</button></p>
    <p v-else-if="!listing" role="status">正在读取通知…</p>

    <RecordWorkspace v-else :selected="!!item">
      <template #list>
        <div v-if="listing.page.items.length" class="entry-list notice-queue">
          <RouterLink
            v-for="row in listing.page.items"
            :key="row.id"
            :aria-current="row.id === item ? 'true' : undefined"
            :to="{ path: listPath + '/' + row.id, query: listQuery }"
          >
            <div>
              <strong>{{ row.title }}</strong>
              <div class="meta-line">
                {{ localDateTime(row.published_at) }} 发布 · 第 {{ row.information_version }} 版 ·
                接收 {{ row.recipient_count }} 人
              </div>
            </div>
            <span class="state-chip">{{ row.is_current ? '当前有效' : '已被替代' }}</span>
          </RouterLink>
        </div>
        <p v-else>本活动还没有发出过通知。</p>
        <Pager
          v-if="page > 1 || listing.page.total > listing.page.page_size"
          :page="page"
          :size="listing.page.page_size"
          :total="listing.page.total"
          @change="
            (n) =>
              $router.push({
                path: listPath,
                query: { ...listQuery, notice_page: n },
              })
          "
        />
      </template>

      <template #detail>
        <RouterLink
          class="back-link"
          :to="{ path: listPath, query: listQuery }"
        >
          <UiIcon name="ArrowLeft" />返回通知列表
        </RouterLink>

        <section v-if="current">
          <h2>{{ current.title }}</h2>
          <div class="meta-line">
            {{ localDateTime(current.published_at) }} 发布 · 第 {{ current.information_version }} 版
          </div>
          <p class="notice-body">{{ current.body }}</p>
          <h3>接收人回执</h3>
          <p v-if="receiptPage" class="receipt-summary">
            接收 {{ current.recipient_count }} 人 · 待跟进 {{ receiptPage.pending }} 人
          </p>
          <div class="row-actions">
            <UiSelect
              label="回执范围"
              v-model="followUp"
              :options="[
                { value: '1', label: '待跟进' },
                { value: '0', label: '全部接收人' },
              ]"
            />
            <button :disabled="loading" @click="reloadReceipts">刷新回执</button>
          <ExportButton
            v-if="current"
            :input="receiptExportInput"
            :disabled="loading"
            @recheck="refreshReceipts"
          />
          </div>
          <p v-if="receiptError" role="alert">{{ receiptError }}</p>
          <p v-else-if="!receipts" role="status">正在读取回执…</p>
          <template v-else>
            <div v-if="receipts.items.length" class="receipt-scroll">
              <table class="receipt-table">
                <thead>
                  <tr>
                    <th>学号</th>
                    <th>姓名</th>
                    <th>状态</th>
                    <th>已读时间</th>
                    <th>确认时间</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in receipts.items" :key="row.student_id">
                    <td>{{ row.student_no }}</td>
                    <td>{{ row.student_name }}</td>
                    <td>
                      {{
                        row.status === 'acknowledged'
                          ? '已确认'
                          : row.status === 'read'
                            ? (current.requires_ack ? '已读未确认' : '已读')
                            : '未读'
                      }}
                    </td>
                    <td>{{ row.read_at ? localDateTime(row.read_at) : '—' }}</td>
                    <td>{{ row.acknowledged_at ? localDateTime(row.acknowledged_at) : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else>
              {{ followUp === '1' ? '当前没有需要跟进的接收人。' : '这条通知没有接收人。' }}
            </p>
            <Pager
              v-if="receiptIndex > 1 || receipts.total > receipts.page_size"
              :page="receiptIndex"
              :size="receipts.page_size"
              :total="receipts.total"
              @change="(n) => $router.push({ query: { ...route.query, receipt_page: n } })"
            />

          </template>
          <p v-if="!current.is_current" class="hint">
            这条通知已被后续版本替代，回执仅作为历史记录保留。
          </p>
        </section>
        <p v-else>未找到该通知。</p>
      </template>
    </RecordWorkspace>
  </section>
</template>

<style scoped>
.notice-queue a {
  flex-wrap: wrap;
}
.notice-queue a[aria-current] {
  background: var(--brand-tint);
  box-shadow: inset 3px 0 var(--brand);
}
.receipt-scroll {
  overflow-x: auto;
}
.notice-body {
  white-space: pre-line;
  line-height: 1.8;
  margin: 16px 0;
  /* 通知正文可能带长链接或长编号，必须允许在任意位置断行，否则会撑破页面。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}
.receipt-summary {
  margin: 4px 0 12px;
  color: var(--text-muted, #666);
}
.row-actions :deep(.platform-select) {
  --select-width: 11rem;
}
.row-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
}
.receipt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.receipt-table th,
.receipt-table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  white-space: nowrap;
}
.hint {
  color: var(--text-muted, #666);
  margin-top: 12px;
}
</style>