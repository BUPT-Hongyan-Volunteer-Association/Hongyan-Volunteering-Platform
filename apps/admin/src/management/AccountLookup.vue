<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, getAccount, listAccounts, type AccountSummary, type RoleGrant } from '@hongyan/contracts';
import { localDateTime } from '@hongyan/ui/activityDisplay';

const route = useRoute();
const number = ref('');
const account = ref<AccountSummary>();
const busy = ref(false);
const message = ref('');
const labels = { student: '学生', organizer: '负责人', reviewer: '老师审核员', tech_admin: '技术管理员' };
const detailId = computed(() => String(route.params.item ?? ''));
let serial = 0;

function reset() {
  serial++;
  account.value = undefined;
  message.value = '';
  busy.value = false;
}

async function lookup() {
  reset();
  if (!detailId.value && !/^\d{10}$/.test(number.value)) {
    message.value = '请输入完整的十位学号，保留开头的 0。';
    return;
  }
  const current = serial;
  busy.value = true;
  try {
    const match = detailId.value
      ? (await getAccount({ path: { id: detailId.value }, throwOnError: true })).data.data
      : (await listAccounts({ query: { q: number.value, page_size: 1 }, throwOnError: true })).data.data.items[0];
    if (serial !== current) return;
    account.value = match;
    if (!match) message.value = '没有找到可查看的账号，请核对学号。';
  } catch (error) {
    if (serial !== current) return;
    message.value = error instanceof ApiError && [403, 404].includes(error.status ?? 0)
      ? '没有找到可查看的账号。' : '查询未完成，请重试。';
  } finally {
    if (serial === current) busy.value = false;
  }
}

watch(detailId, (id) => {
  reset();
  number.value = '';
  if (id) void lookup();
}, { immediate: true });

function validity(grant: RoleGrant) {
  if (!grant.expires_at) return '长期有效';
  return (Date.parse(grant.expires_at) <= Date.now() ? '已到期 · ' : '有效至 ') + localDateTime(grant.expires_at) + '（北京时间）';
}
</script>

<template>
  <section class="lookup">
    <RouterLink v-if="detailId" class="back-link" to="/manage/accounts">返回账号查询</RouterLink>
    <div class="page-heading"><h1>账号与角色</h1><span class="sample-label">只读核对</span></div>
    <form v-if="!detailId" class="lookup-form" novalidate @submit.prevent="lookup">
      <label for="student-lookup">学生学号</label>
      <p id="lookup-hint">按完整十位学号查找；同名学生以学号区分。</p>
      <div class="entry">
        <input id="student-lookup" v-model="number" inputmode="numeric" autocomplete="off"
          aria-describedby="lookup-hint" placeholder="输入十位学号" @input="reset" />
        <button class="primary" :disabled="busy">{{ busy ? '正在查询…' : '查询账号' }}</button>
      </div>
    </form>
    <p role="status">{{ message || (account ? '已找到可查看的账号' : '') }}</p>
    <button v-if="detailId && message" @click="lookup">重新读取</button>
    <section v-if="account" class="identity-card" aria-label="账号核对结果">
      <header class="section-heading"><h2>{{ account.display_name }}</h2><span class="state-chip">{{ account.status === 'active' ? '启用' : '停用' }}</span></header>
      <dl>
        <dt>{{ account.student_id ? '学号' : '登录账号' }}</dt><dd>{{ account.username }}</dd>
        <dt>角色与有效期</dt>
        <dd><ul><li v-for="grant in account.roles" :key="grant.role"><strong>{{ labels[grant.role] }}</strong> · {{ validity(grant) }}</li></ul>
          <span v-if="!account.roles.length">无角色</span></dd>
      </dl>
      <p>此处仅核对身份；具备负责人资格不等于已加入某个活动。</p>
    </section>
  </section>
</template>

<style scoped>
.lookup { max-width: 48rem; }
.lookup-form,.identity-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:clamp(14px,3vw,24px); }
.lookup-form label { font-weight:600; }
.lookup-form p,.identity-card p { color:var(--muted); font-size:14px; }
.entry { display:flex; flex-wrap:wrap; gap:10px; }
.entry input { flex:1 1 14rem; min-width:0; }
.identity-card dl { display:grid; grid-template-columns:auto 1fr; gap:12px 18px; }
.identity-card dt { color:var(--muted); }
.identity-card dd { margin:0; overflow-wrap:anywhere; }
.identity-card ul { list-style:none; margin:0; padding:0; }
.identity-card p { border-top:1px solid var(--line); padding-top:12px; margin-bottom:0; }
</style>
