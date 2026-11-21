<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  listActivityNotices,
  listNoticeReceipts,
  type Notice,
  type NoticePage,
  type Receipt,
  type ReceiptPage,
} from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';

const props = defineProps<{ activityId: string }>();
const route = useRoute();
const item = computed(() => String(route.params.item || ''));
const page = computed(() => {
  const value = Number(route.query.page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
const followUp = ref('1');

const page1 = ref<NoticePage>();
const current = ref<Notice>();
const receipts = ref<ReceiptPage>();
const totals = ref<{ all: number; pending: number }>();
const error = ref('');
const receiptError = ref('');
let serial = 0;
let receiptSerial = 0;

async function loadList() {
  const turn = ++serial;
  error.value = '';
  try {
    const { data } = await listActivityNotices({
      path: { id: props.activityId },
      query: { page: page.value, page_size: 10 },
      throwOnError: true,
    });
    if (turn !== serial) return;
    page1.value = data.data;
    if (item.value) await loadDetail(item.value);
    else {
      current.value = undefined;
      receipts.value = undefined;
    }
  } catch (e) {
    if (turn === serial) error.value = e instanceof Error ? e.message : '通知读取失败';
  }
}

async function loadDetail(id: string) {
  const notice = page1.value?.items.find((row: Notice) => row.id === id);
  current.value = notice;
  await loadReceipts();
}

async function loadReceipts() {
  const notice = current.value;
  if (!notice) return;
  const turn = ++receiptSerial;
  receiptError.value = '';
  receipts.value = undefined;
  try {
    const { data } = await listNoticeReceipts({
      path: { id: notice.id },
      query: { page: 1, page_size: 100, follow_up_only: followUp.value === '1' || undefined },
      throwOnError: true,
    });
    const counts = await Promise.all([
      listNoticeReceipts({ path: { id: notice.id }, query: { page_size: 1 }, throwOnError: true }),
      listNoticeReceipts({
        path: { id: notice.id },
        query: { page_size: 1, follow_up_only: true },
        throwOnError: true,
      }),
    ]);
    if (turn !== receiptSerial) return;
    receipts.value = data.data;
    totals.value = {
      all: counts[0].data.data.total,
      pending: counts[1].data.data.total,
    };
  } catch (e) {
    if (turn === receiptSerial) receiptError.value = e instanceof Error ? e.message : '回执读取失败';
  }
}

watch(() => route.fullPath, loadList, { immediate: true });
watch(followUp, loadReceipts);
</script>

<template>
  <RouterLink
    v-if="item"
    class="back-link"
    :to="{ path: '/managed/' + activityId + '/notices', query: route.query }"
  >
    <UiIcon name="ArrowLeft" />返回通知列表
  </RouterLink>

  <p v-if="error" role="alert">{{ error }} <button @click="loadList">重新读取</button></p>
  <p v-else-if="!page1" role="status">正在读取通知…</p>

  <template v-else-if="!item">
    <div v-if="page1.items.length" class="entry-list">
      <RouterLink
        v-for="row in page1.items"
        :key="row.id"
        :to="{ path: '/managed/' + activityId + '/notices/' + row.id, query: route.query }"
      >
        <div>
          <strong>{{ row.title }}</strong>
          <div class="meta-line">
            {{ localDateTime(row.published_at) }} 发布 · 第 {{ row.information_version }} 版 ·
            接收 {{ row.recipient_count ?? 0 }} 人
          </div>
        </div>
        <span class="state-chip">{{ row.is_current ? '当前有效' : '已被替代' }}</span>
      </RouterLink>
    </div>
    <p v-else>本活动还没有发出过通知。修改活动地点等关键信息并经审核后，系统会通知相关学生。</p>
    <Pager
      :page="page"
      :size="page1.page_size"
      :total="page1.total"
      @change="(n) => $router.push({ query: { ...route.query, page: n } })"
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
      <p v-if="totals" class="receipt-summary">
        接收 {{ totals.all }} 人 · 待跟进 {{ totals.pending }} 人
        <template v-if="totals.pending === 0"> · 全部已确认或已移出</template>
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
        <button :disabled="!receipts" @click="loadReceipts">刷新回执</button>
      </div>
      <p v-if="receiptError" role="alert">{{ receiptError }}</p>
      <p v-else-if="!receipts" role="status">正在读取回执…</p>
      <template v-else>
        <table v-if="receipts.items.length" class="receipt-table">
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
              <td>{{ row.status === 'acknowledged' ? '已确认' : row.status === 'read' ? '已读未确认' : '未读' }}</td>
              <td>{{ row.read_at ? localDateTime(row.read_at) : '—' }}</td>
              <td>{{ row.acknowledged_at ? localDateTime(row.acknowledged_at) : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else>
          {{ followUp === '1' ? '全部接收人都已确认，无需跟进。' : '这条通知没有接收人。' }}
        </p>
        <p class="hint">
          「待跟进」只算当前有效、需要确认且尚未确认的学生；已退出活动或被后续版本替代的不计。
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
