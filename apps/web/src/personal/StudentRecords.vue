<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import UiIcon from '@hongyan/ui/UiIcon.vue';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { personalRecords, title, totalHours } from './examples';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const route = useRoute();
const section = computed(() => route.name as keyof typeof personalRecords);
const titles = {
  hours: '我的时长',
  feedback: '本人记录与反馈',
};
const paths = {
  hours: '/mine/hours',
  feedback: '/mine/feedback',
};
const message = ref('');
const kind = ref('漏记反馈');
watch([section, () => route.params.item], () => {
  message.value = '';
  kind.value = '漏记反馈';
});
function preview() {
  message.value = '当前为表单预览，正式提交待接入。';
}
</script>
<template>
  <RouterLink class="back-link" to="/mine"
    ><UiIcon name="ArrowLeft" />返回我的</RouterLink
  >
  <PreviewRecords
    :title="titles[section]"
    :records="personalRecords[section]"
    :base="paths[section]"
    :table-heading="section === 'hours' ? '活动' : undefined"
    :selected="String(route.params.item || '')"
  >
    <template #summary
      ><p v-if="section === 'hours'" class="hours-total">
        当前累计 <strong>{{ totalHours }} 小时</strong>
      </p></template
    >
    <template #after-list>
      <details v-if="section === 'feedback'">
        <summary>填写反馈（预览）</summary>
        <form class="preview-form" @submit.prevent="preview">
          <label
            >反馈类别<UiSelect label="反馈类别" v-model="kind" :options="['漏记反馈', '异常申诉']"
          /></label>
          <label v-if="kind === '漏记反馈'">活动<UiSelect label="活动" :options="[title]" /></label>
          <label v-if="kind === '漏记反馈'"
            >服务日期<input required type="date" :max="today"
          /></label>
          <label v-if="kind === '漏记反馈'"
            >申报时长（小时，选填）<input type="number" min="0.1" max="999.9" step="0.1"
          /></label>
          <label v-else
            >关联记录<UiSelect label="关联记录" :options="['11 月 14 日已确认异常']"
          /></label>
          <label>本人说明<textarea required /></label><button class="primary">预览提交</button>
        </form>
      </details>
    </template>
  </PreviewRecords>
  <p v-if="message" class="notice" role="status">{{ message }}</p>
</template>
<style scoped>
.hours-total {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 16px;
  padding: 14px 18px;
  background: var(--surface);
  border-radius: var(--radius);
  color: var(--muted);
  font-size: 14px;
}
.hours-total strong {
  color: var(--brand);
  font-size: 20px;
}
</style>
