<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, createAppeal, createCommand, type AppealInput } from '@hongyan/contracts';
import ActivityChoice from '@hongyan/ui/ActivityChoice.vue';
import HourAppeals from '@hongyan/ui/HourAppeals.vue';
import HourIncidents from '@hongyan/ui/HourIncidents.vue';
import { message } from '@hongyan/ui/usePageRead';

const route = useRoute(), router = useRouter();
const linked = computed(() => typeof route.query.target === 'string' ? route.query.target : undefined);
const type = computed(() => linked.value && route.query.kind === 'incident' ? 'incident' : linked.value ? 'hours' : 'missing_hours');
const editing = computed(() => !route.params.item && (!!linked.value || route.query.new === '1'));
const description = ref(''), activity = ref(''), day = ref(''), hours = ref(''), error = ref(''), busy = ref(false), saved = ref(false);
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const command = createCommand();
const appeals = ref<InstanceType<typeof HourAppeals>>();
let formVersion = 0;
onScopeDispose(() => { formVersion++; });
watch([type, linked, editing], () => {
  formVersion++; busy.value = false;
  description.value = ''; activity.value = ''; day.value = ''; hours.value = ''; error.value = ''; command.confirmed();
});
async function submit() {
  if (!description.value.trim() || busy.value) return;
  const version = formVersion;
  const body: AppealInput = {
    target_type: type.value, description: description.value.trim(),
    ...(linked.value ? { target_id: linked.value } : {
      activity_id: activity.value, service_date: day.value, ...(hours.value && { requested_hours: hours.value }),
    }),
  };
  busy.value = true; error.value = ''; saved.value = false;
  try {
    const { data } = await createAppeal({ body, throwOnError: true,
      headers: command.headers('create_appeal', linked.value ?? activity.value + '/' + day.value, body) });
    if (version !== formVersion) return;
    command.confirmed();
    saved.value = true;
    await router.push('/mine/feedback/' + data.data.id);
    await appeals.value?.refresh(false);
  } catch (reason) {
    if (version !== formVersion) return;
    error.value = message(reason);
    if (reason instanceof ApiError && reason.status !== undefined && reason.status < 500) command.confirmed();
  } finally { if (version === formVersion) busy.value = false; }
}
</script>
<template>
  <section class="reading-area feedback">
    <RouterLink class="back-link" to="/mine">返回我的</RouterLink>
    <h1>本人记录与反馈</h1>
    <p v-if="saved" role="status">反馈已提交。</p>
    <div class="page-actions" v-if="!route.params.item && !editing">
      <RouterLink class="button primary" :to="{ path: '/mine/feedback', query: { new: '1' } }">提交漏记反馈</RouterLink>
      <RouterLink to="/mine/hours">查看我的时长</RouterLink>
    </div>
    <form v-if="editing" class="feedback-form" @submit.prevent="submit">
      <h2>{{ type === 'missing_hours' ? '漏记反馈' : type === 'hours' ? '反馈这笔时长' : '异常申诉' }}</h2>
      <fieldset :disabled="busy">
        <template v-if="type === 'missing_hours'">
          <ActivityChoice v-model="activity" label="服务活动" scope="public" />
          <label>服务日期<input type="date" v-model="day" :max="today" required /></label>
          <label>申报时长（小时，选填）<input type="text" inputmode="decimal" v-model="hours" pattern="(0\.[1-9]|[1-9][0-9]{0,2}(\.[0-9])?)" /></label>
        </template>
        <label>情况说明
          <textarea v-model="description" rows="4" maxlength="6000" required
            :placeholder="type === 'missing_hours' ? '请说明实际服务内容。未报名者请注明参加方式与当日情况。' : '请说明需要老师核实的情况。'" />
        </label>
        <div class="page-actions">
          <button type="submit" class="primary" :disabled="!description.trim() || (!linked && (!activity || !day))">提交反馈</button>
          <RouterLink to="/mine/feedback">取消</RouterLink>
        </div>
      </fieldset>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
    <HourAppeals v-else ref="appeals" mode="self" />
    <HourIncidents v-if="!route.params.item && !editing" mode="self" />
  </section>
</template>
<style scoped>
.feedback-form fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.feedback-form label { display: grid; gap: 6px; margin: 12px 0; max-width: 42rem; }
.feedback-form { padding-block: 8px; }
</style>
