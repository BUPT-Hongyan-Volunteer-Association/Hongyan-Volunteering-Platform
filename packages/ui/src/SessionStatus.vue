<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElButton } from 'element-plus';
import { ApiError, getProfile } from '@hongyan/contracts';

const status = ref<'loading' | 'ready' | 'failed'>('loading');
const detail = ref('');
const requestId = ref('');

async function connect() {
  status.value = 'loading';
  detail.value = '';
  requestId.value = '';
  try {
    await getProfile({ throwOnError: true, cache: 'no-store' });
    status.value = 'ready';
  } catch (error) {
    status.value = 'failed';
    detail.value = error instanceof Error ? error.message : '连接检查失败，请重试。';
    if (error instanceof ApiError) requestId.value = error.body?.request_id ?? '';
  }
}

onMounted(connect);
</script>

<template>
  <section class="connection" :aria-busy="status === 'loading'">
    <div role="status" aria-live="polite">
      <h2>
        <span aria-hidden="true" class="signal" :class="status"></span>
        {{ status === 'ready' ? '服务已连接' : status === 'failed' ? '连接失败' : '正在连接服务' }}
      </h2>
      <p v-if="detail">{{ detail }}</p>
      <p v-if="requestId">请求编号：{{ requestId }}</p>
    </div>
    <ElButton type="primary" :loading="status === 'loading'" @click="connect">
      {{ status === 'failed' ? '重试' : '重新连接' }}
    </ElButton>
  </section>
</template>

<style scoped>
.connection { display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 24px 0; border-top: 1px solid var(--line); }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 18px; }
.signal { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.signal.ready { background: #217049; }
.signal.failed { background: #b03c32; }
p { margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .connection { align-items: flex-start; flex-direction: column; }
}
</style>
