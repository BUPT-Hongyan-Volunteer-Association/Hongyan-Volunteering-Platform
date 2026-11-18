<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { personalRecords, title, totalHours } from './examples';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const route = useRoute();
const section = computed(() => route.name as keyof typeof personalRecords);
const titles = {
  registrations: '我的报名',
  notices: '通知',
  hours: '我的时长',
  feedback: '本人记录与反馈',
};
const paths = {
  registrations: '/registrations',
  notices: '/notices',
  hours: '/mine/hours',
  feedback: '/mine/feedback',
};
const message = ref('');
const kind = ref('漏记反馈');
watch(
  () => route.fullPath,
  () => {
    message.value = '';
    kind.value = '漏记反馈';
  },
);
function preview() {
  message.value = '当前为表单预览，正式提交待接入。';
}
</script>
<template>
  <RouterLink v-if="section === 'feedback' || section === 'hours'" to="/mine">返回我的</RouterLink>
  <PreviewRecords
    :title="titles[section]"
    :records="personalRecords[section]"
    :base="paths[section]"
    :selected="String(route.params.item || '')"
  >
    <template #summary
      ><p v-if="section === 'hours'">
        当前累计 <strong>{{ totalHours }} 小时</strong>
      </p></template
    >
    <template #detail="{ record }">
      <RouterLink v-if="section === 'registrations'" :to="{ path: '/mine/example-activity' }"
        >查看活动详情</RouterLink
      >
      <button v-if="section === 'notices' && record.status === '未读'" @click="preview">
        预览确认回执
      </button>
    </template>
    <template #after-list>
      <details v-if="section === 'feedback'">
        <summary>填写反馈（预览）</summary>
        <form class="preview-form" @submit.prevent="preview">
          <label
            >反馈类别<select v-model="kind">
              <option>漏记反馈</option>
              <option>异常申诉</option>
            </select></label
          >
          <label v-if="kind === '漏记反馈'"
            >活动<select>
              <option>{{ title }}</option>
            </select></label
          >
          <label v-if="kind === '漏记反馈'"
            >服务日期<input required type="date" :max="today"
          /></label>
          <label v-if="kind === '漏记反馈'"
            >申报时长（小时，选填）<input type="number" min="0.1" max="999.9" step="0.1"
          /></label>
          <label v-else
            >关联记录<select>
              <option>11 月 14 日已确认异常</option>
            </select></label
          >
          <label>本人说明<textarea required /></label><button>预览提交</button>
        </form>
      </details>
    </template>
  </PreviewRecords>
  <p v-if="message" role="status">{{ message }}</p>
</template>
