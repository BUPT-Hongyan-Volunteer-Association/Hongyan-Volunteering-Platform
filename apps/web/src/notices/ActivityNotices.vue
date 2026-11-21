<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listActivityNotices, listNoticeReceipts } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { pageNumber, usePageRead } from '../usePageRead';

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
const followUp = computed({
  get: () => (route.query.receipts === 'all' ? '0' : '1'),
  set: (value) => {
    void router.push({
      query: { ...listQuery.value, receipts: value === '0' ? 'all' : undefined },
    });
  },
});

const {
  data: listing,
  error,
  refresh,
} = usePageRead(
  () => [activityId.value, item.value, page.value].join('/'),
  async (signal) =>
    (
      await listActivityNotices({
        path: { id: activityId.value },
        query: item.value ? { notice_id: item.value } : { page: page.value, page_size: 10 },
        signal,
        throwOnError: true,
      })
    ).data.data,
);
const current = computed(() => (item.value ? listing.value?.items[0] : undefined));
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
async function reloadReceipts() {
  await refresh(false);
  if (current.value) await refreshReceipts();
}
</script>

<template>
  <h2 v-if="!item">通知与回执</h2>
  <RouterLink
    v-if="item"
    class="back-link"
    :to="{ path: '/managed/' + activityId + '/notices', query: listQuery }"
  >
    <UiIcon name="ArrowLeft" />返回通知列表
  </RouterLink>

  <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重新读取</button></p>
  <p v-else-if="!listing" role="status">正在读取通知…</p>

  <template v-else-if="!item">
    <div v-if="listing.items.length" class="entry-list">
      <RouterLink
        v-for="row in listing.items"
        :key="row.id"
        :to="{ path: '/managed/' + activityId + '/notices/' + row.id, query: route.query }"
      >
        <div>
          <strong>{{ row.title }}</strong>
          <div class="meta-line">
            {{ localDateTime(row.published_at) }} 发布 · 第 {{ row.information_version }} 版 · 接收
            {{ row.recipient_count ?? 0 }} 人
          </div>
        </div>
        <span class="state-chip">{{ row.is_current ? '当前有效' : '已被替代' }}</span>
      </RouterLink>
    </div>
    <p v-else>本活动还没有发出过通知。修改活动地点等关键信息并经审核后，系统会通知相关学生。</p>
    <Pager
      :page="page"
      :size="listing.page_size"
      :total="listing.total"
      @change="(n) => $router.push({ query: { ...listQuery, notice_page: n } })"
    />
  </template>

  <template v-else>
    <section v-if="current">
      <h2>{{ current.title }}</h2>
      <div class="meta-line">
        {{ localDateTime(current.published_at) }} 发布 · 第 {{ current.information_version }} 版
      </div>
      <p class="notice-body">{{ current.body }}</p>
      <h3>接收人回执</h3>
      <p v-if="receiptPage" class="receipt-summary">
        接收 {{ current.recipient_count }} 人 · 待跟进 {{ receiptPage.pending }} 人
        <template v-if="receiptPage.pending === 0"> · 全部已确认或已移出</template>
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
                        ? '已读未确认'
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
        <p class="hint">
          「待跟进」只算当前有效、需要确认且尚未确认的学生。已退出活动的学生会移出集合和变更通知的待跟进名单。
        </p>
      </template>
      <p v-if="!current.is_current" class="hint">
        这条通知已被后续版本替代，回执仅作为历史记录保留。
      </p>
    </section>
    <p v-else>未找到该通知。</p>
  </template>
</template>

<style scoped>
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
