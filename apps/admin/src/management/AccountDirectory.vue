<script setup lang="ts">
import { ref, watch } from 'vue';
import { listAccounts, type AccountSummary, type RoleGrant } from '@hongyan/contracts';
import Pager from '@hongyan/ui/Pager.vue';
import { usePageRead } from '@hongyan/ui/usePageRead';

const role = ref<RoleGrant['role'] | ''>('');
const status = ref<AccountSummary['status'] | ''>('');
const page = ref(1);
watch([role, status], () => { page.value = 1; }, { flush: 'sync' });
const { data: rows, error, refresh } = usePageRead(
  () => [role.value, status.value, page.value],
  async signal => (await listAccounts({ query: { role: role.value || undefined,
    status: status.value || undefined, page: page.value, page_size: 20 }, signal, throwOnError: true })).data.data,
);
</script>

<template>
  <section>
    <h2>账号列表</h2>
    <div class="page-actions">
      <label>筛选角色 <select v-model="role">
        <option value="">全部角色</option><option value="student">学生</option><option value="organizer">负责人</option>
        <option value="reviewer">老师审核员</option><option value="tech_admin">技术管理员</option>
      </select></label>
      <label>筛选账号状态 <select v-model="status">
        <option value="">全部状态</option><option value="active">启用</option><option value="inactive">停用</option>
      </select></label>
    </div>
    <p v-if="error" role="alert">{{ error }} <button @click="refresh()">重新读取</button></p>
    <p v-else-if="!rows" role="status">正在读取账号…</p>
    <template v-else>
      <p v-if="!rows.total">没有符合条件的账号。</p>
      <ul v-else><li v-for="item in rows.items" :key="item.account_id">
        <RouterLink :to="'/manage/accounts/' + item.account_id">{{ item.display_name }} · {{ item.username }}</RouterLink>
        · {{ item.status === 'active' ? '启用' : '停用' }}{{ item.credential_pending ? ' · 凭证待发放' : '' }}
      </li></ul>
      <Pager v-if="rows.total > rows.page_size" :page="page" :size="rows.page_size" :total="rows.total" @change="page = $event" />
    </template>
  </section>
</template>
