<script setup lang="ts">
import { ref } from 'vue';
import {
  ApiError,
  getActivityRevision,
  listActivityRevisions,
  type ActivityRevision,
  type ActivityRevisionPage,
} from '@hongyan/contracts';
import ActivitySnapshot from '@hongyan/ui/ActivitySnapshot.vue';
import Pager from '@hongyan/ui/Pager.vue';
import { revisionLabels } from '@hongyan/ui/activityDisplay';

const props = defineProps<{ id: string }>();
const history = ref<ActivityRevisionPage>();
const viewed = ref<ActivityRevision>();
const page = ref(1),
  loading = ref(false),
  error = ref('');
let request = 0;

async function loadPage(next: number) {
  const turn = ++request;
  page.value = next;
  loading.value = true;
  history.value = undefined;
  viewed.value = undefined;
  error.value = '';
  try {
    const { data } = await listActivityRevisions({
      path: { id: props.id },
      query: { page: next },
      throwOnError: true,
    });
    if (turn === request) history.value = data.data;
  } catch (e) {
    if (turn === request) error.value = e instanceof Error ? e.message : '版本历史读取失败';
  } finally {
    if (turn === request) loading.value = false;
  }
}
async function inspect(revision: number) {
  const turn = ++request;
  viewed.value = undefined;
  error.value = '';
  try {
    const { data } = await getActivityRevision({
      path: { id: props.id, revision },
      throwOnError: true,
    });
    if (turn === request) viewed.value = data.data;
  } catch (e) {
    if (turn !== request) return;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status ?? 0)) history.value = undefined;
    error.value = e instanceof Error ? e.message : '版本读取失败';
  }
}
function toggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open && !history.value && !loading.value)
    void loadPage(page.value);
}
</script>

<template>
  <details class="history" @toggle="toggle">
    <summary>版本历史</summary>
    <p v-if="loading" role="status">正在读取版本…</p>
    <p v-if="error" role="alert">
      {{ error }} <button @click="loadPage(page)">重新读取版本</button>
    </p>
    <template v-if="history">
      <div class="page-actions">
        <button
          v-for="v in history.items"
          :key="v.revision"
          :aria-pressed="viewed?.revision === v.revision"
          @click="inspect(v.revision)"
        >
          版本 {{ v.revision }} · {{ revisionLabels[v.revision_state] }}
        </button>
      </div>
      <Pager
        v-if="history.total > history.page_size"
        :page="history.page"
        :size="history.page_size"
        :total="history.total"
        @change="loadPage"
      />
      <ActivitySnapshot v-if="viewed" :content="viewed.content" />
    </template>
  </details>
</template>

<style scoped>
.history {
  padding: 12px 0;
  border-top: 1px solid var(--line);
}
.history .page-actions {
  margin-top: 10px;
}
.history button[aria-pressed='true'] {
  background: var(--brand-tint);
  border-color: var(--brand);
}
</style>
