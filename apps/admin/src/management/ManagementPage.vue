<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Profile } from '@hongyan/contracts';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import type { PreviewRecord } from '@hongyan/ui/preview';
import { sections, type SectionKey } from './sections';
const props = defineProps<{ profile: Profile }>();
const route = useRoute();
const key = computed(() => route.params.section as SectionKey);
const section = computed(() => sections[key.value]);
const isAdmin = computed(() => props.profile.roles.includes('tech_admin'));
const rows = computed<PreviewRecord[]>(() =>
  section.value.records.filter(
    (r) => key.value !== 'accounts' || isAdmin.value || r.id === 'student-0123',
  ),
);
const message = ref('');
const action = ref('');
const reason = ref('');
const actions = computed(() => {
  switch (key.value) {
    case 'accounts':
      return route.params.item === 'staff-002'
        ? isAdmin.value
          ? ['停用独立后台账号', '重置后台凭证']
          : []
        : ['授予负责人角色', '重置学生凭证'];
    case 'students':
      return ['修正学生档案', '停用学生账号'];
    case 'imports':
      return ['确认建档'];
    case 'failures':
      return ['重试原事件'];
    case 'incidents':
      return ['核实属实', '核实不成立'];
    case 'corrections':
      return ['批准整组', '驳回整组'];
    case 'appeals':
      return route.params.item === 'A2026-014' ? ['开始核查', '驳回申请'] : ['驳回申请'];
    default:
      return [];
  }
});
watch(
  () => [route.fullPath, isAdmin.value],
  () => {
    message.value = '';
    reason.value = '';
    action.value = actions.value[0] || '';
  },
  { immediate: true },
);
</script>
<template>
  <PreviewRecords
    :title="section.title"
    :records="rows"
    :base="'/manage/' + key"
    :selected="String(route.params.item || '')"
  >
    <template #detail>
      <div v-if="key === 'imports'" class="scroll-table">
        <table>
          <caption>
            原表第 2 行
          </caption>
          <thead>
            <tr>
              <th v-for="col in ['学号', '姓名', '级部', '年级', '班级']" :key="col">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>0000000123</th>
              <td>林同学</td>
              <td>本科生</td>
              <td>2026</td>
              <td>0000000201</td>
            </tr>
          </tbody>
        </table>
      </div>
      <form
        v-if="actions.length"
        class="preview-form"
        @submit.prevent="message = '当前为示例预览，' + action + '尚未提交。'"
      >
        <label
          >操作<select v-model="action" aria-label="操作">
            <option v-for="option in actions" :key="option">{{ option }}</option>
          </select></label
        >
        <label>处理意见<textarea v-model="reason" /></label><button>预览操作</button>
      </form>
      <p v-if="message" role="status">{{ message }}</p>
    </template>
  </PreviewRecords>
</template>
