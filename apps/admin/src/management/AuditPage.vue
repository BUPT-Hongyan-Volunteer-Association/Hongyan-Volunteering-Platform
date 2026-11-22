<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import { listAuditEvents, type AuditEvent } from '@hongyan/contracts';

const route = useRoute(),
  router = useRouter();
const size = 20;
const actor = ref(''),
  resource = ref(''),
  from = ref(''),
  to = ref('');
const rows = ref<AuditEvent[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
let serial = 0;

const page = computed(() => {
  const value = Number(route.query.page);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
});
function localValue(iso: unknown) {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTime() - date.getTimezoneOffset() * 60000;
  return new Date(offset).toISOString().slice(0, 16);
}
function iso(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function displayTime(value: string) {
  return time.format(new Date(value));
}
function pretty(value?: string) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
async function load() {
  const current = ++serial;
  loading.value = true;
  error.value = '';
  try {
    const query = {
      ...(route.query.actor_id ? { actor_id: String(route.query.actor_id) } : {}),
      ...(route.query.resource_id ? { resource_id: String(route.query.resource_id) } : {}),
      ...(route.query.from ? { from: String(route.query.from) } : {}),
      ...(route.query.to ? { to: String(route.query.to) } : {}),
      page: page.value,
      page_size: size,
    };
    const result = (await listAuditEvents({ query, throwOnError: true })).data.data;
    if (current !== serial) return;
    rows.value = result.items;
    total.value = result.total;
  } catch (reason) {
    if (current === serial) error.value = reason instanceof Error ? reason.message : '读取审计记录失败';
  } finally {
    if (current === serial) loading.value = false;
  }
}
watch(
  () => route.query,
  () => {
    actor.value = String(route.query.actor_id ?? '');
    resource.value = String(route.query.resource_id ?? '');
    from.value = localValue(route.query.from);
    to.value = localValue(route.query.to);
    return load();
  },
  { immediate: true },
);
function apply() {
  void router.push({
    query: {
      ...(actor.value.trim() ? { actor_id: actor.value.trim() } : {}),
      ...(resource.value.trim() ? { resource_id: resource.value.trim() } : {}),
      ...(from.value ? { from: iso(from.value) } : {}),
      ...(to.value ? { to: iso(to.value) } : {}),
      page: 1,
    },
  });
}
function clear() {
  void router.push({ query: {} });
}
function goPage(next: number) {
  void router.push({ query: { ...route.query, page: next } });
}
</script>

<template>
  <div class="page-heading">
    <div class="page-title">
      <h1>审计记录</h1>
      <span class="state-chip neutral">共 {{ total }} 条</span>
    </div>
    <p class="page-hint">只读记录，按操作者、业务对象和时间查询；不展示凭证、令牌或完整敏感附件。</p>
  </div>
  <form class="filters" @submit.prevent="apply">
    <label>操作者 ID<input v-model="actor" type="search" placeholder="账号 UUID" /></label>
    <label>对象 ID<input v-model="resource" type="search" placeholder="业务对象 UUID" /></label>
    <label>起始时间<input v-model="from" type="datetime-local" /></label>
    <label>结束时间<input v-model="to" type="datetime-local" /></label>
    <button class="primary" type="submit">查询</button>
    <button type="button" @click="clear">清除筛选</button>
  </form>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试读取</button></p>
  <p v-else-if="loading" role="status">正在读取审计记录…</p>
  <template v-else>
    <div v-if="rows.length" class="scroll-table">
      <table>
        <caption>审计记录</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">操作人</th>
            <th scope="col">动作</th>
            <th scope="col">对象</th>
            <th scope="col">原因</th>
            <th scope="col">变更</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td><time :datetime="row.created_at">{{ displayTime(row.created_at) }}</time></td>
            <td class="mono">{{ row.actor_id }}</td>
            <td>{{ row.action }}</td>
            <td><span class="mono">{{ row.resource_type }}</span><small class="mono">{{ row.resource_id }}</small></td>
            <td>{{ row.reason || '—' }}</td>
            <td>
              <details v-if="row.before || row.after">
                <summary>查看前后值</summary>
                <pre v-if="row.before">变更前：{{ pretty(row.before) }}</pre>
                <pre v-if="row.after">变更后：{{ pretty(row.after) }}</pre>
              </details>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state"><p>没有匹配的审计记录</p></div>
    <Pager v-if="total > size" :page="page" :size="size" :total="total" @change="goPage" />
  </template>
</template>

<style scoped>
.page-hint {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 14px;
}
.filters {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 18px;
}
.filters label {
  display: grid;
  gap: 5px;
  font-size: 14px;
  color: var(--muted);
  min-width: 0;
}
.filters input {
  width: 18rem;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
td small {
  display: block;
  color: var(--muted);
}
pre {
  max-width: 36rem;
  max-height: 16rem;
  overflow: auto;
  margin: 4px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
