<script setup lang="ts">
import { ref } from 'vue';
import UiIcon, { type IconName } from '@hongyan/ui/UiIcon.vue';
import { activityTypes as types, localDateTime as date } from '@hongyan/ui/activityDisplay';
import type { Activity } from '@hongyan/contracts';
defineProps<{ activity: Activity; showRegistrations: boolean }>();
const origin = window.history.state?.scheduleReturn;
const scheduleReturn =
  typeof origin === 'string' && /^\/(?:mine\/)?schedule(?:\?|$)/.test(origin) ? origin : undefined;
const contact = ref<HTMLDialogElement>();
const phases = {
  open: '报名中',
  not_open: '尚未开放',
  closed: '报名已截止',
  unavailable: '当前不可报名',
};
const conditions: [keyof Activity, string, IconName][] = [
  ['meeting_point', '集合地点', 'Location'],
  ['transport_notes', '交通', 'Guide'],
  ['eligibility_text', '报名条件', 'User'],
  ['safety_notes', '安全说明', 'Warning'],
  ['group_join_instructions', '入群方式', 'Message'],
];
const statuses = {
  accepted: '已录取',
  submitted: '已提交，待审核',
  waitlisted: '候补中',
  rejected: '未录取',
  withdrawn: '已撤回',
  exited: '已退出',
};
</script>
<template>
  <article class="activity-detail">
    <div class="detail-top">
      <RouterLink
        :to="scheduleReturn || { path: '/', query: $route.query }"
        :aria-label="scheduleReturn ? '返回日程' : '返回活动列表'"
        ><UiIcon name="ArrowLeft" />活动详情</RouterLink
      ><RouterLink v-if="showRegistrations" to="/registrations">我的报名</RouterLink>
    </div>
    <div class="detail-columns">
      <div class="detail-intro">
        <div class="page-actions">
          <span class="state-chip">{{ types[activity.schedule.schedule_type] }}</span
          ><span v-if="activity.registration_phase" class="phase">{{
            phases[activity.registration_phase]
          }}</span>
        </div>
        <h1>{{ activity.title }}</h1>
        <dl class="location">
          <dt class="sr-only">活动地点</dt>
          <dd>{{ [activity.campus, activity.location].filter(Boolean).join(' · ') }}</dd>
        </dl>
        <dl class="facts">
          <template v-if="activity.schedule.schedule_type !== 'continuous'"
            ><dt><UiIcon name="Calendar" />活动周期</dt>
            <dd>
              {{ activity.schedule.duration_start_date }} 至
              {{ activity.schedule.duration_end_date }}
            </dd></template
          >
          <dt><UiIcon name="Clock" />服务时段</dt>
          <dd v-if="activity.schedule.schedule_type === 'weekly'">
            <div
              v-for="rule in activity.schedule.weekly_slots"
              :key="rule.weekday + '-' + rule.start_time"
            >
              每周{{ '一二三四五六日'[rule.weekday - 1] }} {{ rule.start_time.slice(0, 5) }}–{{
                rule.end_day_offset ? '次日 ' : ''
              }}{{ rule.end_time.slice(0, 5) }}
            </div>
            <div v-for="d in activity.schedule.excluded_dates" :key="d">{{ d }} 暂停</div>
            <div v-for="s in activity.schedule.additional_slots" :key="s.starts_at">
              补充 {{ date(s.starts_at) }} 至 {{ date(s.ends_at) }}
            </div>
          </dd>
          <dd v-else-if="activity.schedule.schedule_type === 'custom'">
            <div v-for="s in activity.schedule.slots" :key="s.starts_at">
              {{ date(s.starts_at) }} 至 {{ date(s.ends_at) }}
            </div>
          </dd>
          <dd v-else>{{ date(activity.starts_at) }} 至 {{ date(activity.ends_at) }}</dd>
          <template v-if="activity.registration_closes_at"
            ><dt><UiIcon name="Calendar" />报名截止</dt>
            <dd>
              <mark>{{ date(activity.registration_closes_at) }}</mark>
            </dd></template
          >
          <dt><UiIcon name="User" />录取名额</dt>
          <dd>{{ activity.capacity }} 人</dd>
          <template v-if="activity.expected_hours"
            ><dt><UiIcon name="Timer" />预计时长</dt>
            <dd>
              {{ activity.expected_hours_basis === 'whole_activity' ? '整期' : '每次' }}
              {{ activity.expected_hours }} 小时
            </dd></template
          >
        </dl>
      </div>
      <div class="detail-body">
        <section v-if="activity.description || activity.beneficiaries">
          <h2>服务内容</h2>
          <p>{{ activity.description }}</p>
          <p v-if="activity.beneficiaries">服务对象 · {{ activity.beneficiaries }}</p>
        </section>
        <section>
          <h2>集合与参与条件</h2>
          <dl class="conditions">
            <template v-for="[key, label, icon] in conditions" :key="key">
              <template v-if="activity[key]"
                ><dt><UiIcon :name="icon" />{{ label }}</dt>
                <dd>{{ activity[key] }}</dd></template
              >
            </template>
          </dl>
        </section>
        <aside class="joining">
          <h2>报名须知</h2>
          <p>本活动统一报名，录取后查看入群方式。</p>
          <p v-if="activity.schedule.schedule_type === 'weekly'">每周参加报名在活动群内完成。</p>
        </aside>
        <details
          v-if="
            activity.registration_opens_at ||
            activity.result_expected_at ||
            activity.selection_text ||
            activity.hours_rule_text
          "
        >
          <summary>录取、时长与报名时间</summary>
          <dl>
            <template v-if="activity.selection_text"
              ><dt>录取说明</dt>
              <dd>{{ activity.selection_text }}</dd></template
            >
            <template v-if="activity.hours_rule_text"
              ><dt>时长认定</dt>
              <dd>{{ activity.hours_rule_text }}</dd></template
            >
            <template v-if="activity.registration_opens_at"
              ><dt>报名开放</dt>
              <dd>{{ date(activity.registration_opens_at) }}</dd></template
            >
            <template v-if="activity.result_expected_at"
              ><dt>结果公布</dt>
              <dd>{{ date(activity.result_expected_at) }}</dd></template
            >
          </dl>
        </details>
      </div>
    </div>
    <footer class="detail-footer">
      <button class="primary" disabled aria-describedby="apply-reason">
        {{
          activity.my_registration_status ? statuses[activity.my_registration_status] : '申请报名'
        }}</button
      ><small id="apply-reason">报名功能待接入</small>
      <button v-if="activity.contact_text" class="contact-btn" @click="contact?.showModal()">
        <UiIcon name="Message" />联系负责人
      </button>
    </footer>
    <dialog ref="contact" aria-labelledby="contact-title">
      <h2 id="contact-title">联系负责人</h2>
      <p>{{ activity.contact_text }}</p>
      <form method="dialog"><button autofocus>关闭</button></form>
    </dialog>
  </article>
</template>

<style scoped>
.activity-detail {
  max-width: 1060px;
}
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
details {
  margin-top: 8px;
}
summary {
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
summary::before {
  content: '▸';
}
details[open] summary::before {
  content: '▾';
}
.joining {
  background: var(--surface);
  padding: 12px 14px;
  border-radius: var(--radius);
}
.joining h2 {
  border-left: 3px solid var(--yellow);
  padding-left: 9px;
}
.detail-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding-block: 14px;
  border-top: 1px solid var(--line);
  background: white;
}
.detail-footer .primary {
  min-width: 170px;
}
.detail-footer small {
  color: var(--muted);
}
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
  .detail-footer {
    position: fixed;
    z-index: 4;
    inset: auto 0 0;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 3px 8px;
    padding: 8px 16px max(6px, env(safe-area-inset-bottom));
  }
  .detail-footer .primary {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    width: 100%;
  }
  .detail-footer small {
    grid-column: 1 / -1;
    grid-row: 2;
    text-align: center;
    font-size: 12px;
  }
  .detail-footer .contact-btn {
    grid-column: 2;
    grid-row: 1;
  }
  .detail-footer:not(:has(.contact-btn)) {
    grid-template-columns: 1fr;
  }
}
</style>
