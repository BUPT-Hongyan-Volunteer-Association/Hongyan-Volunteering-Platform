<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { createCommand, listNotificationEvents, retryNotificationEvent, type NotificationEvent } from '@hongyan/contracts';
import RecordWorkspace from '@hongyan/ui/RecordWorkspace.vue';
import StatusFilter from '@hongyan/ui/StatusFilter.vue';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { message, pageNumber, usePageRead } from '@hongyan/ui/usePageRead';

const route = useRoute(), router = useRouter();
const labels = { failed: '投递失败', pending: '等待投递', running: '投递中', delivered: '已投递', superseded: '已被替代' };
const eventTypes: Record<string, string> = {
  activity_changed: '活动安排变更', registration_decided: '报名结果', request_decided: '退出与恢复结果',
  gathering_supplement: '集合通知补发', hours_result: '时长结果', appeal_result: '申诉结果', hours_feedback: '时长反馈',
};
const id = computed(() => String(route.params.item ?? ''));
const status = computed(() => Object.hasOwn(labels, String(route.query.status)) ? route.query.status as NotificationEvent['status'] : 'failed');
const page = computed(() => pageNumber(route.query.page));
const { data: queue, error, refresh: load } = usePageRead(() => [status.value, page.value], async signal =>
  (await listNotificationEvents({ query: { status: status.value, page: page.value }, signal, throwOnError: true })).data.data);
const { data: event, loading: detailLoading, error: detailError, refresh: read } = usePageRead(id, async signal => id.value
  ? (await listNotificationEvents({ query: { id: id.value, page_size: 1 }, signal, throwOnError: true })).data.data.items[0]
  : undefined);
watch(queue, data => {
  if (!data || id.value || data.page <= 1 || data.items.length) return;
  const last = Math.max(1, Math.ceil(data.total / data.page_size));
  void router.replace({ query: { ...route.query, page: last > 1 ? last : undefined } });
});
const reason = ref(''), feedback = ref(''), problem = ref(''), saving = ref(false), heading = ref<HTMLElement>();
const command = createCommand();
watch(id, () => { reason.value = feedback.value = problem.value = ''; });
watch(() => event.value?.id, async selected => { if (selected) { await nextTick(); heading.value?.focus(); } });
async function retry() {
  if (!event.value || event.value.status !== 'failed' || !reason.value.trim() || saving.value) return;
  const row = event.value, body = { expected_version: row.version, reason: reason.value.trim() };
  saving.value = true;
  problem.value = feedback.value = '';
  try {
    const result = await retryNotificationEvent({ path: { id: row.id }, body,
      headers: command.headers('retry_notification_event', row.id, body), throwOnError: true });
    command.confirmed();
    if (id.value === row.id) {
      feedback.value = '事件已重新排队';
      event.value = result.data.data;
      reason.value = '';
      await read(false);
    }
    await load(false);
  } catch (e) { if (id.value === row.id) { problem.value = message(e); await read(false); } }
  finally { saving.value = false; }
}
function setFilter(value: string) {
  void router.push({path: '/manage/failures', query: {status: value === 'failed' ? undefined : value}});
}
</script>

<template>
  <h1>通知失败队列</h1>
  <RecordWorkspace :selected="!!id">
    <template #list>
      <StatusFilter label="投递状态" :options="labels" :model-value="status" @update:model-value="setFilter" />
      <p v-if="error" role="alert">{{ error }} <button @click="load()">重新读取</button></p>
      <p v-else-if="!queue" role="status">正在读取通知事件…</p>
      <p v-else-if="!queue.total">当前条件下没有通知事件</p>
      <div v-else class="entry-list">
        <RouterLink v-for="item in queue.items" :key="item.id" :to="{ path: '/manage/failures/' + item.id, query: route.query }"
          :aria-current="item.id === id ? 'true' : undefined">
          <span><strong>{{ eventTypes[item.event_type] ?? item.event_type }}</strong><br><small>{{ localDateTime(item.created_at) }} · {{ item.id.slice(0, 8) }}</small></span><span class="state-chip">{{ labels[item.status] }}</span>
          <span class="row-end"><UiIcon name="ArrowRight" /></span>
        </RouterLink>
      </div>
      <Pager v-if="queue && queue.total > queue.page_size" :page="queue.page" :size="queue.page_size" :total="queue.total"
        @change="n => router.push({ path: '/manage/failures', query: { ...route.query, page: n } })" />
    </template>
    <template #detail>
      <RouterLink class="back-link" :to="{ path: '/manage/failures', query: route.query }"><UiIcon name="ArrowLeft" />返回通知队列</RouterLink>
      <p v-if="detailError" role="alert">{{ detailError }} <button @click="read()">重新读取</button></p>
      <p v-else-if="detailLoading && !event" role="status">正在读取通知事件…</p>
      <template v-else-if="event">
        <h2 ref="heading" tabindex="-1">通知事件详情</h2>
        <dl><dt>当前状态</dt><dd>{{ labels[event.status] }}</dd><dt>事件类型</dt><dd>{{ eventTypes[event.event_type] ?? event.event_type }}</dd>
          <dt>尝试次数</dt><dd>{{ event.attempt_count }}</dd><dt>事件编号</dt><dd>{{ event.id }}</dd>
          <template v-if="event.last_error"><dt>失败原因</dt><dd>{{ event.last_error }}</dd></template>
        </dl>
        <form v-if="event.status === 'failed'" class="form-section" @submit.prevent="retry">
          <label class="form-field">重试原因<textarea v-model="reason" required maxlength="2000" rows="2" /></label>
          <div><button class="primary" :disabled="saving || !reason.trim()">重新排队</button></div>
        </form>
        <button @click="read(false); load(false)">刷新投递状态</button>
      </template>
      <p v-else>未读取到通知事件</p>
      <p v-if="feedback" role="status">{{ feedback }}</p><p v-if="problem" role="alert">{{ problem }}</p>
    </template>
  </RecordWorkspace>
</template>
