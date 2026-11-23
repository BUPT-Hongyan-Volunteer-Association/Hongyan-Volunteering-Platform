<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { listMyNotices } from '@hongyan/contracts';
import { noAccess } from '@hongyan/ui/usePageRead';

const count = ref<number>();
let request: AbortController | undefined;
let timer: number | undefined;

async function refresh(event?: Event) {
  if (document.hidden) return;
  request?.abort();
  const current = new AbortController();
  request = current;
  try {
    const { data } = await listMyNotices({
      query: { page_size: 1, with_counts: true }, cache: 'no-store',
      signal: current.signal, throwOnError: true,
    });
    if (current.signal.aborted) return;
    const next = data.data.inbox_counts!.attention;
    const changed = count.value !== undefined && next !== count.value;
    count.value = next;
    // 收件箱已在焦点和本人写入时刷新，仅广播后台发现的变化。
    if (changed && !event) window.dispatchEvent(new Event('hongyan-inbox-changed'));
  } catch (error) {
    if (!current.signal.aborted && noAccess(error)) count.value = 0;
  }
}
function visibility() {
  window.clearInterval(timer);
  if (document.hidden) {
    request?.abort();
    return;
  }
  void refresh();
  timer = window.setInterval(refresh, 60_000);
}
onMounted(() => {
  visibility();
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', refresh);
  window.addEventListener('hongyan-notice-updated', refresh);
});
onUnmounted(() => {
  request?.abort();
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('focus', refresh);
  window.removeEventListener('hongyan-notice-updated', refresh);
});
</script>
<template>
  <span v-if="count" class="notice-badge">
    <span aria-hidden="true">{{ count > 99 ? '99+' : count }}</span>
    <span class="sr-only" id="notice-attention-description">有 {{ count }} 条未读或待确认通知</span>
  </span>
</template>
<style scoped>
.notice-badge {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 18px;
  padding: 0 5px;
  height: 18px;
  border-radius: 12px;
  color: white;
  background: #b42318;
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 700px) {
  .notice-badge { position: absolute; top: 1px; left: calc(50% + 4px); }
}
</style>
