<script setup lang="ts">
import { serviceDateText } from '@hongyan/contracts/activity';
import { computed, ref } from 'vue';
import UiIcon, { type IconName } from '@hongyan/ui/UiIcon.vue';
import ActivitySignup from './ActivitySignup.vue';
import { activityPrimaryStatus, localDateTime as date } from '@hongyan/ui/activityDisplay';
import {
  listMyNotices,
  type Activity, type Student,
  type Registration,
} from '@hongyan/contracts';
import { usePageRead } from '@hongyan/ui/usePageRead';
const props = defineProps<{
  activity: Activity;
  showRegistrations: boolean;
  refreshing: boolean;
  student?: Student;
}>();
const emit = defineEmits<{ applied: [registrations: Registration[]]; refresh: [] }>();
const showSignupDates = computed(() => props.showRegistrations && props.activity.status === 'published');
const origin = window.history.state?.scheduleReturn;
const scheduleReturn =
  typeof origin === 'string' && /^\/(?:mine\/)?schedule(?:\?|$)/.test(origin) ? origin : undefined;
const registrationPath = window.history.state?.registrationReturn;
const registrationReturn =
  typeof registrationPath === 'string' &&
  /^\/registrations(?:\/[a-f0-9-]+)?(?:\?|$)/i.test(registrationPath)
    ? registrationPath
    : undefined;
const noticePath = window.history.state?.noticeReturn;
const noticeReturn = typeof noticePath === 'string' && /^\/notices\/[a-f0-9-]+(?:\?|$)/i.test(noticePath)
  ? noticePath : undefined;
const contact = ref<HTMLDialogElement>();
const { data: pendingNotices } = usePageRead(
  () => props.showRegistrations && props.activity.id,
  async (signal) => props.showRegistrations
    ? (await listMyNotices({
        query: { activity_id: props.activity.id, unacknowledged_only: true, page_size: 1 },
        signal, throwOnError: true,
      })).data.data.total
    : 0,
);
const conditions: [keyof Activity, string, IconName][] = [
  ['meeting_point', '集合地点', 'Location'],
  ['transport_notes', '交通', 'Guide'],
  ['safety_notes', '安全或培训说明', 'Warning'],
  ['group_join_instructions', '入群方式', 'Message'],
];
</script>
<template>
  <article class="activity-detail">
    <div class="detail-top">
      <RouterLink class="button compact"
        :to="noticeReturn || registrationReturn || scheduleReturn || { path: '/', query: $route.query }"
        :aria-label="
          noticeReturn ? '返回通知详情' : registrationReturn ? (/^\/registrations\//.test(registrationReturn) ? '返回报名详情' : '返回我的报名') : scheduleReturn ? '返回日程' : '返回活动列表'
        "
        ><UiIcon name="ArrowLeft" />活动详情</RouterLink
      ><RouterLink class="button compact" v-if="showRegistrations" to="/registrations">我的报名</RouterLink>
    </div>
    <p v-if="pendingNotices" class="notice-callout">
      <UiIcon name="Bell" />
      本活动有 {{ pendingNotices }} 条通知待确认，
      <RouterLink class="button compact" :to="{ path: '/notices', query: { pending: '1', activity_id: activity.id } }">去查看并确认</RouterLink>
    </p>
    <div v-if="activity.schedule" class="detail-columns">
      <div class="detail-intro">
        <div class="page-actions">
          <span v-if="activity.registration_phase" class="phase">{{
            activityPrimaryStatus(activity)
          }}</span>
        </div>
        <h1>{{ activity.title }}</h1>
        <dl class="location">
          <dt class="sr-only">活动地点</dt>
          <dd>{{ [activity.campus, activity.location].filter(Boolean).join(' · ') }}</dd>
        </dl>
        <dl class="facts">
          <dt><UiIcon name="Calendar" />活动日期</dt>
          <dd>{{ serviceDateText(activity.schedule) }}</dd>
          <dt><UiIcon name="User" />录取名额</dt>
          <dd>{{ activity.capacity }} 人</dd>
          <dt><UiIcon name="User" />候补名额</dt><dd>{{ activity.waitlist_capacity ?? 0 }} 人</dd>
          <template v-if="activity.registration_mode !== 'batch' && activity.item_availability?.[0]">
            <dt>剩余可报</dt><dd>{{ activity.item_availability[0].remaining }} 人</dd>
          </template>
          <template v-if="showSignupDates && activity.registration_opens_at">
            <dt><UiIcon name="Calendar" />报名开放</dt>
            <dd><time :datetime="activity.registration_opens_at">{{ date(activity.registration_opens_at) }}</time></dd>
          </template>
          <template v-if="showSignupDates && activity.registration_closes_at">
            <dt><UiIcon name="Calendar" />报名截止</dt>
            <dd><mark><time :datetime="activity.registration_closes_at">{{ date(activity.registration_closes_at) }}</time></mark></dd>
          </template>
        </dl>
        <section v-if="activity.hours_import_date || activity.hours_rule_text" class="service-hours">
          <h2>服务时长</h2>
          <dl>
            <template v-if="activity.hours_rule_text">
              <dt>时长认定</dt>
              <dd>{{ activity.hours_rule_text }}</dd>
            </template>
            <template v-if="activity.hours_import_date">
              <dt>预计时长导入日期</dt>
              <dd><time :datetime="activity.hours_import_date">{{ activity.hours_import_date }}</time></dd>
            </template>
          </dl>
        </section>
      </div>
      <div class="detail-body">
        <section v-if="activity.description || activity.beneficiaries">
          <h2>服务内容</h2>
          <p v-if="activity.description">{{ activity.description }}</p>
          <p v-if="activity.beneficiaries">服务对象 · {{ activity.beneficiaries }}</p>
        </section>
        <section v-if="activity.precautions"><h2>注意事项</h2><p class="description">{{ activity.precautions }}</p></section>
        <section v-if="activity.related_notes"><h2>相关说明</h2><p class="description">{{ activity.related_notes }}</p></section>
        <section v-if="activity.group_qr_id || conditions.some(([key]) => activity[key])">
          <h2>集合与参与条件</h2>
          <dl class="conditions">
            <template v-if="activity.group_qr_id"><dt>入群二维码</dt><dd><img width="180" style="max-width:100%" :src="'/api/v1/activity-group-images/' + activity.group_qr_id" alt="活动群二维码" /></dd></template>
            <template v-for="[key, label, icon] in conditions" :key="key">
              <template v-if="activity[key]"
                ><dt><UiIcon :name="icon" />{{ label }}</dt>
                <dd>{{ activity[key] }}</dd></template
              >
            </template>
          </dl>
        </section>
      </div>
    </div>
    <ActivitySignup :activity="activity" :student="showRegistrations ? student : undefined" :refreshing="refreshing" @applied="emit('applied', $event)" @refresh="emit('refresh')">
      <button v-if="activity.contacts?.length" type="button" class="contact-btn" @click="contact?.showModal()"><UiIcon name="Message" />联系负责人</button>
    </ActivitySignup>
    <dialog ref="contact" aria-labelledby="contact-title">
      <h2 id="contact-title">联系负责人</h2>
      <p v-for="(value,index) in activity.contacts" :key="index">{{ value }}</p>
      <form method="dialog"><button autofocus>关闭</button></form>
    </dialog>
  </article>
</template>

<style scoped>
.detail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}
.detail-top a {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 550;
  text-decoration: none;
}
.detail-top a:first-child {
  color: var(--ink);
}
.detail-columns {
  display: grid;
  grid-template-columns: minmax(0, 0.97fr) minmax(0, 1.03fr);
  gap: clamp(20px, 4vw, 64px);
  padding-block: 24px;
}
.detail-intro .page-actions {
  justify-content: space-between;
}
.phase {
  padding: 2px 8px;
  border: 1px solid #9ab0d2;
  border-radius: 5px;
  color: var(--brand);
  font-weight: 550;
  font-size: 13px;
}
h1 {
  margin: 12px 0 3px;
}
h2 {
  font-size: 17px;
  margin-bottom: 7px;
}
dl {
  grid-template-columns: 6em minmax(0, 1fr);
  margin: 0;
  gap: 8px 12px;
  font-size: 14px;
}
.location {
  display: block;
  color: var(--muted);
}
.facts {
  margin-top: 18px;
  grid-template-columns: 6.5em minmax(0, 1fr);
}
.facts dt { white-space: nowrap; }
.facts dt,
.conditions dt {
  display: flex;
  align-items: center;
  gap: 7px;
}
dl .ui-icon {
  color: var(--brand);
  width: 16px;
  height: 16px;
}
.facts dd {
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
mark {
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--brand);
  background: var(--yellow-tint);
}
.detail-body {
  padding-left: clamp(20px, 3vw, 40px);
  border-left: 1px solid var(--line);
}
.detail-body section {
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
p {
  margin: 3px 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.service-hours {
  margin-top: 18px;
}
.service-hours dl {
  grid-template-columns: max-content minmax(0, 1fr);
}
.service-hours dt,
.service-hours time {
  white-space: nowrap;
}
.description { white-space: pre-wrap; }
dialog {
  width: min(370px, calc(100vw - 32px));
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px;
}
dialog::backdrop {
  background: #17243a55;
}
dialog button {
  margin-top: 16px;
}
@media (max-width: 960px) {
  .detail-columns {
    display: block;
    padding-block: 16px;
  }
  .detail-body {
    border-left: 0;
    padding-left: 0;
  }
  .detail-intro {
    border-bottom: 1px solid var(--line);
    margin-bottom: 14px;
    padding-bottom: 14px;
  }
}
@media (max-width: 700px) {
  .activity-detail {
    padding-bottom: calc(92px + env(safe-area-inset-bottom));
  }
  .detail-top {
    padding-block: 3px;
  }
  .detail-top a {
    min-height: 44px;
  }

}
.notice-callout {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin: 0 0 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.notice-callout a {
  background-color: var(--brand-tint);
}
</style>
