<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Pager from '@hongyan/ui/Pager.vue';
import { beijingInput, beijingISO, localDateTime } from '@hongyan/ui/activityDisplay';
import ActivityDateField from '@hongyan/ui/ActivityDateField.vue';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import { listAuditEvents } from '@hongyan/contracts';

const route = useRoute(),
  router = useRouter();
const size = 20;
const actionLabels: Record<string, string> = {
  submit: '提交', withdraw: '撤回', approve: '批准', reject: '驳回', approved: '批准', rejected: '驳回',
  confirmed: '核实属实', revoked: '撤销', resolved: '结案', in_review: '受理', cancelled: '取消',
  create: '创建', download: '下载', update_student: '更新学生档案', decide_registrations: '处理报名',
  set_account_status: '调整账号状态', set_account_roles: '调整角色授权', create_staff_account: '创建后台账号',
  issue_temporary_password: '签发临时凭证', reset_password: '重置登录凭证', review_activity: '审核活动',
  add_activity_member: '添加活动成员', remove_activity_member: '移除活动成员',
  transfer_activity_owner: '交接活动负责人', set_activity_members: '调整活动团队',
};
const resourceLabels: Record<string, string> = {
  activity: '活动', activity_review: '活动审核', account: '账号', student: '学生档案', export: '导出作业',
  incident: '现场异常', hour_appeal: '时长反馈', hour_batch: '时长批次', hour_correction_group: '时长修复组',
  exit_request: '退出申请', restoration_request: '恢复申请',
};
const actor = ref(''),
  resource = ref(''),
  from = ref(''),
  to = ref('');
const page = computed(() => pageNumber(route.query.page));
const { data, loading, error, refresh: load } = usePageRead(() => route.query, async signal =>
  (await listAuditEvents({ query: {
    actor_id: typeof route.query.actor_id === 'string' ? route.query.actor_id : undefined,
    resource_id: typeof route.query.resource_id === 'string' ? route.query.resource_id : undefined,
    from: typeof route.query.from === 'string' ? route.query.from : undefined,
    to: typeof route.query.to === 'string' ? route.query.to : undefined,
    page: page.value, page_size: size,
  }, signal, throwOnError: true })).data.data);
const rows = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
function pretty(value?: string) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
watch(
  () => route.query,
  () => {
    actor.value = String(route.query.actor_id ?? '');
    resource.value = String(route.query.resource_id ?? '');
    from.value = beijingInput(route.query.from);
    to.value = beijingInput(route.query.to);
  },
  { immediate: true },
);
function apply() {
  void router.push({
    query: {
      ...(actor.value.trim() ? { actor_id: actor.value.trim() } : {}),
      ...(resource.value.trim() ? { resource_id: resource.value.trim() } : {}),
      ...(from.value ? { from: beijingISO(from.value) } : {}),
      ...(to.value ? { to: beijingISO(to.value) } : {}),
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
  </div>
  <form class="filter-bar" @submit.prevent="apply">
    <label>操作者 ID<input v-model="actor" type="search" placeholder="账号 UUID" /></label>
    <label>对象 ID<input v-model="resource" type="search" placeholder="业务对象 UUID" /></label>
    <div class="form-field">起始时间（北京时间）<ActivityDateField v-model="from" label="起始时间" with-time /></div>
    <div class="form-field">结束时间（北京时间）<ActivityDateField v-model="to" label="结束时间" with-time /></div>
    <button class="primary" type="submit">查询</button>
    <button type="button" @click="clear">清除筛选</button>
  </form>
  <p v-if="error" role="alert">{{ error }} <button type="button" @click="load()">重试读取</button></p>
  <p v-else-if="loading" role="status">正在读取审计记录…</p>
  <template v-else>
    <div v-if="rows.length" class="scroll-table">
      <table>
        <caption>审计记录</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">动作</th>
            <th scope="col">对象</th>
            <th scope="col">原因</th>
            <th scope="col">变更</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td><time :datetime="row.created_at">{{ localDateTime(row.created_at) }}</time></td>
            <td>{{ actionLabels[row.action] ?? row.action }}</td>
            <td>{{ resourceLabels[row.resource_type] ?? row.resource_type }}</td>
            <td>{{ row.reason || '—' }}</td>
            <td>
              <details>
                <summary>查看变更</summary>
                <dl><dt>动作代码</dt><dd>{{ row.action }}</dd><dt>操作人 ID</dt><dd>{{ row.actor_id }}</dd><dt>对象 ID</dt><dd>{{ row.resource_id }}</dd></dl>
                <pre v-if="row.before">变更前：{{ pretty(row.before) }}</pre>
                <pre v-if="row.after">变更后：{{ pretty(row.after) }}</pre>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state"><p>没有匹配的审计记录</p></div>
    <Pager v-if="data && total > data.page_size" :page="page" :size="data.page_size" :total="total" @change="goPage" />
  </template>
</template>

<style scoped>
.filter-bar input {
  width: 18rem;
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
