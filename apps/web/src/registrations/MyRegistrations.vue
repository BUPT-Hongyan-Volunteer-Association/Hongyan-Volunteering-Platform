<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { listMyRegistrations, type Registration, type RegistrationPage } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { localDateTime } from '@hongyan/ui/activityDisplay';
import { registrationLabels } from './labels';

const route = useRoute();
const router = useRouter();
const page = computed(() => Number(route.query.page || 1));
const status = computed(() => String(route.query.status || '') as Registration['status'] | '');
const item = computed(() => String(route.params.item || ''));
const options = [
  { value: '', label: '全部状态' },
  ...Object.entries(registrationLabels).map(([value, label]) => ({ value, label })),
];
const result = ref<RegistrationPage>();
const selected = computed(() => result.value?.items[0]);
const error = ref('');
let serial = 0;
async function load() {
  const turn = ++serial;
  error.value = '';
  result.value = undefined;
  try {
    const { data } = await listMyRegistrations({
      query: item.value
        ? { id: item.value }
        : {
            page: page.value,
            page_size: 10,
            status: status.value || undefined,
          },
      throwOnError: true,
    });
    if (turn === serial) result.value = data.data;
  } catch (e) {
    if (turn === serial) error.value = e instanceof Error ? e.message : '报名记录读取失败';
  }
}
function filter(value: string) {
  void router.push({ path: '/registrations', query: { status: value || undefined } });
}
watch(() => route.fullPath, load, { immediate: true });
onMounted(() => window.addEventListener('focus', load));
onUnmounted(() => {
  serial++;
  window.removeEventListener('focus', load);
});
</script>

<template>
  <RouterLink v-if="item" class="back-link" :to="{ path: '/registrations', query: route.query }">
    <UiIcon name="ArrowLeft" />返回我的报名
  </RouterLink>
  <header class="page-heading">
    <h1>{{ item ? '报名详情' : '我的报名' }}</h1>
    <UiSelect
      v-if="!item"
      label="报名状态"
      :model-value="status"
      :options="options"
      @update:model-value="filter"
    />
  </header>
  <p v-if="error" role="alert">{{ error }} <button @click="load">重新读取</button></p>
  <p v-else-if="!result" role="status">正在读取报名记录…</p>
  <template v-else-if="item">
    <section v-if="selected">
      <h2>{{ selected.activity_title || '活动报名' }}</h2>
      <dl class="detail-fields">
        <dt>报名状态</dt>
        <dd>{{ registrationLabels[selected.status] }}</dd>
        <dt>提交时间</dt>
        <dd>{{ localDateTime(selected.submitted_at) }}</dd>
        <template v-if="selected.statement"
          ><dt>申请说明</dt>
          <dd>{{ selected.statement }}</dd></template
        >
        <template v-if="selected.decision_reason"
          ><dt>处理说明</dt>
          <dd>{{ selected.decision_reason }}</dd></template
        >
      </dl>
      <RouterLink
        class="button"
        :to="{
          path: '/activities/' + selected.activity_id,
          state: { registrationReturn: route.fullPath },
        }"
        >查看活动详情</RouterLink
      >
    </section>
    <p v-else>未找到该报名记录。</p>
  </template>
  <template v-else>
    <div v-if="result.items.length" class="entry-list">
      <RouterLink
        v-for="row in result.items"
        :key="row.id"
        :to="{ path: '/registrations/' + row.id, query: route.query }"
      >
        <div>
          <strong>{{ row.activity_title || '活动报名' }}</strong>
          <div class="meta-line">{{ localDateTime(row.submitted_at) }} 提交</div>
        </div>
        <span class="state-chip">{{ registrationLabels[row.status] }}</span>
      </RouterLink>
    </div>
    <p v-else>暂无符合条件的报名记录。</p>
    <Pager
      :page="page"
      :size="result.page_size"
      :total="result.total"
      @change="(n) => router.push({ query: { ...route.query, page: n } })"
    />
  </template>
</template>
