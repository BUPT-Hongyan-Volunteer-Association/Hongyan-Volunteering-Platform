<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UiSelect from '@hongyan/ui/UiSelect.vue';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { roleOptions, accountStatusLabels } from './accountLabels';
import { listAccounts, type AccountSummary, type RoleGrant } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';

const route = useRoute(), router = useRouter();
const role = computed(() => String(route.query.role ?? '') as RoleGrant['role'] | '');
const status = computed(() => String(route.query.status ?? '') as AccountSummary['status'] | '');
const page = computed(() => pageNumber(route.query.page));
function filter(key: 'role' | 'status', value: string) {
  void router.replace({ query: { ...route.query, [key]: value || undefined, page: undefined } });
}
const { data: rows, error, refresh } = usePageRead(
  () => [role.value, status.value, page.value],
  async signal => (await listAccounts({ query: { role: role.value || undefined,
    status: status.value || undefined, page: page.value, page_size: 20 }, signal, throwOnError: true })).data.data,
);
watch(rows, async result => {
  if (result && typeof window.history.state?.returnFocus === 'string') {
    await nextTick();
    document.getElementById(window.history.state.returnFocus)?.focus();
  }
}, { once: true });
</script>

<template>
  <section>
    <h2>账号列表</h2>
    <div class="page-actions">
      <label>筛选角色 <UiSelect label="筛选角色" :model-value="role" :options="[{ value: '', label: '全部角色' }, ...roleOptions]"
        @update:model-value="filter('role', $event)" /></label>
      <label>筛选账号状态 <UiSelect label="筛选账号状态" :model-value="status"
        :options="[{ value: '', label: '全部状态' }, ...Object.entries(accountStatusLabels).map(([value,label]) => ({value,label}))]"
        @update:model-value="filter('status', $event)" /></label>
    </div>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重新读取</button></p>
    <p v-else-if="!rows" role="status">正在读取账号…</p>
    <template v-else>
      <p v-if="!rows.total">没有符合条件的账号</p>
      <div v-else class="entry-list">
        <RouterLink v-for="item in rows.items" :key="item.account_id" :id="'account-' + item.account_id"
          :aria-label="item.display_name + ' · ' + item.username"
          :to="{ path: '/manage/accounts/' + item.account_id, query: route.query }">
          <strong>{{ item.display_name }} · {{ item.username }}</strong>
          <span class="row-end">{{ accountStatusLabels[item.status] }}{{ item.credential_pending ? ' · 凭证待发放' : '' }} <UiIcon name="ArrowRight" /></span>
        </RouterLink>
      </div>
      <Pager v-if="rows.total > rows.page_size" :page="page" :size="rows.page_size" :total="rows.total" @change="n => router.replace({ query: { ...route.query, page: n } })" />
    </template>
  </section>
</template>
