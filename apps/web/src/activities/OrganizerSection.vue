<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { requests } from '../registrations/requests';
import { attendance } from '../notices/organizer';
import ActivityNotices from '../notices/ActivityNotices.vue';
import { appeals, corrections } from '../hours/organizer';
import { incidents } from '../incidents/organizer';

const route = useRoute();
const sections = {
  requests: { title: '退出与恢复', records: requests },
  notices: { title: '通知与回执', records: [] as typeof attendance },
  attendance: { title: '现场人员记录', records: attendance },
  appeals: { title: '漏记反馈', records: appeals },
  corrections: { title: '错账修复组', records: corrections },
  incidents: { title: '异常上报', records: incidents },
};
const section = computed(() => route.params.area as keyof typeof sections);
const date = ref('');
const feedback = ref('');
const records = computed(() => {
  const list = sections[section.value].records;
  if (section.value !== 'attendance' || !date.value) return list;
  return list.filter((r) => r.fields.some(([k, v]) => k === '服务日期' && v === date.value));
});
watch(
  () => route.fullPath,
  () => {
    feedback.value = '';
  },
);
</script>
<template>
  <ActivityNotices
    v-if="section === 'notices'"
    :activity-id="String(route.params.id)"
  />
  <PreviewRecords
    v-else
    :title="sections[section].title"
    :records="records"
    :base="'/managed/' + route.params.id + '/' + section"
    :selected="String(route.params.item || '')"
  >
    <template #filters>
      <label v-if="section === 'attendance'">服务日期 <input type="date" v-model="date" /></label>
    </template>
    <template #detail="{ record }">
      <button
        v-if="section === 'requests' && record.status === '待处理'"
        @click="feedback = '示例申请尚待接入，处理决定未提交。'"
      >
        预览处理决定
      </button>
    </template>
    <template #after-list>
      <details v-if="section === 'incidents'">
        <summary>填写异常报告（预览）</summary>
        <form class="preview-form" @submit.prevent="feedback = '示例报告尚待接入。'">
          <label>人员<UiSelect label="人员" :options="['周同学', '林同学']" /></label>
          <label>服务日期<input required type="date" /></label
          ><label>事实及说明<textarea required /></label> <label>证据说明<input /></label
          ><button class="primary">预览报告</button>
        </form>
      </details>
    </template>
  </PreviewRecords>
  <p v-if="feedback" role="status">{{ feedback }}</p>
</template>
