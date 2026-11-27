<script setup lang="ts">
import { activityBounds, isUnpublishedDraft, serviceDateText } from '@hongyan/contracts/activity';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ApiError, createCommand, deleteActivityDraft, listManagedActivities, type Activity, type Profile } from '@hongyan/contracts';
import { useRoute, useRouter } from 'vue-router';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import { activityPrimaryStatus } from '@hongyan/ui/activityDisplay';
import { pageNumber, usePageRead } from '@hongyan/ui/usePageRead';
import Pager from '@hongyan/ui/Pager.vue';

const props = defineProps<{ profile: Profile }>();
const dialog = ref<HTMLDialogElement>();
const selected = ref<Activity>();
const deleting = ref(false), failure = ref(''), feedback = ref('');
const command = createCommand();
const route = useRoute(), router = useRouter();
const page = computed(() => pageNumber(route.query.page));
const sourceQuery = computed(() => ({ page: page.value > 1 ? page.value : undefined }));
const { data, loading, error, refresh: load } = usePageRead(page, async signal =>
  (await listManagedActivities({ query: { scope: 'managed', page: page.value, page_size: 20 }, signal, throwOnError: true })).data.data);
function openDelete(activity: Activity) {
  selected.value = activity;
  failure.value = feedback.value = '';
  dialog.value?.showModal();
}
async function confirmDelete() {
  const draft = selected.value;
  if (!draft || deleting.value) return;
  const body = { expected_version: draft.version };
  deleting.value = true;
  failure.value = '';
  try {
    await deleteActivityDraft({ path: { id: draft.id }, body,
      headers: command.headers('delete_activity_draft', draft.id, body), throwOnError: true });
    command.confirmed();
    dialog.value?.close();
    feedback.value = '已删除草稿「' + draft.title + '」';
    await load();
  } catch (reason) {
    if (reason instanceof ApiError && [401, 403, 404, 409].includes(reason.status ?? 0)) {
      dialog.value?.close();
      feedback.value = reason.status === 409 ? '草稿已变化，请核对最新状态' : reason.message;
      await load();
    } else failure.value = reason instanceof Error ? reason.message : '删除结果未确认，请重试';
  } finally { deleting.value = false; }
}
function refreshVisible() {
  if (!document.hidden) void load(false);
}
watch(data, (rows, _previous, cleanup) => {
  if (!rows) return;
  const lastPage = Math.max(1, Math.ceil(rows.total / rows.page_size));
  if (page.value > lastPage) {
    void router.replace({ query: { ...route.query, page: lastPage > 1 ? lastPage : undefined } });
    return;
  }
  if (!rows.items.length) return;
  const evaluated = Date.parse(rows.items[0].state_evaluated_at ?? '');
  const next = rows.items.flatMap(item => {
    const bounds = activityBounds(item.schedule);
    return [bounds?.start, bounds?.end, Date.parse(item.registration_opens_at ?? ''), Date.parse(item.registration_closes_at ?? '')];
  }).filter((time): time is number => typeof time === 'number' && time > evaluated);
  const timer = window.setTimeout(refreshVisible, Math.min(60000, ...next.map(time => time - evaluated + 1)));
  cleanup(() => window.clearTimeout(timer));
});
onMounted(() => document.addEventListener('visibilitychange', refreshVisible));
onUnmounted(() => document.removeEventListener('visibilitychange', refreshVisible));
</script>

<template>
  <div class="reading-area">
    <div class="page-heading">
      <h1>我的管理活动</h1>
    </div>
    <p v-if="feedback" role="status" class="notice">{{ feedback }}</p>
    <p v-if="loading && !data" class="notice" role="status">正在读取活动…</p>
    <p v-else-if="error" role="alert">{{ error }} <button @click="load()">刷新</button></p>
    <div v-else-if="!data?.items.length" class="empty-state">
      <UiIcon name="FolderOpened" />
      <p>暂无可管理的活动</p>
    </div>
    <ul v-else class="managed-list">
      <li v-for="a in data.items" :key="a.id">
        <div class="managed-info">
          <div class="meta-line">{{ a.activity_code }}</div>
          <div class="page-title">
            <RouterLink class="row-title" :to="{ path: '/managed/' + a.id + (isUnpublishedDraft(a) ? '/edit' : ''), query: sourceQuery }">
              {{ a.title }}<UiIcon name="ArrowRight" />
            </RouterLink>
            <span class="state-chip" :class="{ attention: a.has_pending_review }">{{
              activityPrimaryStatus(a)
            }}</span>
            <span v-if="a.has_pending_review && a.status !== 'pending_review'" class="state-chip attention">待审核</span>
          </div>
          <div class="meta-line">
            <span v-if="a.location"
              ><UiIcon name="Location" />{{
                [a.campus, a.location].filter(Boolean).join(' · ')
              }}</span
            ><span><UiIcon name="Calendar" />{{ serviceDateText(a.schedule) }}</span>
            <span v-if="a.has_pending_review && a.status !== 'pending_review'" class="state-chip attention">待审核</span>
          </div>
        </div>
        <div v-if="isUnpublishedDraft(a)" class="page-actions">
          <RouterLink class="button" :to="{ path: '/managed/' + a.id + '/edit', query: sourceQuery }">
            <UiIcon name="EditPen" />编辑送审
          </RouterLink>
          <button v-if="a.owner_account_id === props.profile.account_id" type="button" class="delete-draft" @click="openDelete(a)">删除</button>
        </div>
        <div v-else class="page-actions">
          <RouterLink class="button" :to="{ path: '/managed/' + a.id + '/attendance', query: sourceQuery }">
            <UiIcon name="DocumentChecked" />现场人员记录
          </RouterLink>
          <RouterLink
            class="button"
            :to="{ path: '/managed/' + a.id + '/roster', query: sourceQuery }"
            ><UiIcon name="Tickets" />报名名单</RouterLink
          >
        </div>
      </li>
    </ul>
    <dialog ref="dialog" aria-labelledby="draft-delete-title" aria-describedby="draft-delete-description"
      @cancel="deleting && $event.preventDefault()">
      <form @submit.prevent="confirmDelete">
        <h2 id="draft-delete-title">删除草稿</h2>
        <p id="draft-delete-description">确定删除「{{ selected?.title }}」？删除后无法恢复编辑。</p>
        <p v-if="failure" role="alert">{{ failure }}</p>
        <div class="page-actions dialog-actions">
          <button type="button" autofocus :disabled="deleting" @click="dialog?.close()">取消</button>
          <button type="submit" class="delete-draft" :disabled="deleting">{{ deleting ? '正在删除…' : '确认删除' }}</button>
        </div>
      </form>
    </dialog>
    <Pager
      v-if="!loading && data && data.total > data.page_size"
      :page="page"
      :size="data.page_size"
      :total="data.total"
      @change="(next) => router.push({ query: { page: next } })"
    />
  </div>
</template>
<style scoped>
button.delete-draft { background:var(--danger); border-color:var(--danger); color:white; }
button.delete-draft:enabled:hover { background:#802a20; border-color:#802a20; color:white; }
dialog { max-width:min(28rem, 90vw); padding:20px; border:1px solid var(--line); border-radius:var(--radius); }
dialog::backdrop { background:#17243a55; }
dialog h2 { margin-top:0; }
dialog p { overflow-wrap:anywhere; }
.dialog-actions { justify-content:flex-end; margin-top:16px; }
.managed-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-top: 1px solid var(--line);
}
.managed-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px 24px;
  padding: 18px 2px;
  border-bottom: 1px solid var(--line);
}
.managed-info {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.row-title {
  color: var(--ink);
  font-size: 18px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: var(--compact-height);
  font-weight: var(--weight-heading);
  text-decoration: none;
  overflow-wrap: anywhere;
}
.row-title:hover { color: var(--brand); background: var(--brand-tint); }
.row-title .ui-icon { width: 14px; }
@media (max-width: 700px), (pointer: coarse) { .row-title { min-height: 44px; } }
</style>
