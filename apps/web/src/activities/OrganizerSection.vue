<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { requests } from '../registrations/requests';
import { notices, receipts, attendance } from '../notices/organizer';
import { batches, appeals, corrections } from '../hours/organizer';
import { incidents } from '../incidents/organizer';

defineProps<{ activityCode: string }>();
const route = useRoute();
const sections = {
  requests: { title: '退出与恢复', records: requests },
  notices: { title: '通知与回执', records: notices },
  attendance: { title: '现场人员记录', records: attendance },
  batches: { title: '时长批次', records: batches },
  appeals: { title: '漏记反馈', records: appeals },
  corrections: { title: '错账修复组', records: corrections },
  incidents: { title: '异常上报', records: incidents },
};
const section = computed(() => route.params.area as keyof typeof sections);
const date = ref('');
const receiptFilter = ref('待跟进');
const feedback = ref('');
const records = computed(() => {
  const list = sections[section.value].records;
  if (section.value !== 'attendance' || !date.value) return list;
  return list.filter(r => r.fields.some(([k,v]) => k === '服务日期' && v === date.value));
});
watch(() => route.fullPath, () => { feedback.value = ''; receiptFilter.value = '待跟进'; });
</script>
<template>
  <label v-if="section === 'attendance' && !route.params.item">服务日期 <input type="date" v-model="date" /></label>
  <PreviewRecords :title="sections[section].title" :records="records" :base="'/managed/' + route.params.id + '/' + section" :selected="String(route.params.item || '')">
    <template #detail="{ record }">
      <template v-if="section === 'notices'">
        <h3>接收人回执</h3><label>回执名单 <select v-model="receiptFilter"><option>待跟进</option><option>已确认</option></select></label>
        <ul><li v-for="r in receipts.filter(r => (r.status === '已确认') === (receiptFilter === '已确认'))" :key="r.name">{{ r.name }} · {{ r.status }}</li></ul>
      </template>
      <div v-if="section === 'batches'" class="scroll-table"><table><caption>导入预览</caption><thead><tr>
        <th v-for="h in ['学号','姓名','活动编号','服务日期','认证时长（小时）','备注','是否有违纪情况']" :key="h">{{ h }}</th>
      </tr></thead><tbody><tr><th>0000000123</th><td>林同学</td><td>{{ activityCode }}</td><td>2026-11-14</td><td>2.0</td><td>整理资料</td><td>无</td></tr></tbody></table></div>
      <button v-if="section === 'requests' && record.status === '待处理'" @click="feedback = '示例申请尚待接入，处理决定未提交。'">预览处理决定</button>
    </template>
    <template #after-list>
      <details v-if="section === 'incidents'"><summary>填写异常报告（预览）</summary>
        <form class="preview-form" @submit.prevent="feedback = '示例报告尚待接入。'">
          <label>人员<select><option>周同学</option><option>林同学</option></select></label>
          <label>服务日期<input required type="date" /></label><label>事实及说明<textarea required /></label>
          <label>证据说明<input /></label><button>预览报告</button>
        </form>
      </details>
    </template>
  </PreviewRecords>
  <p v-if="feedback" role="status">{{ feedback }}</p>
</template>
