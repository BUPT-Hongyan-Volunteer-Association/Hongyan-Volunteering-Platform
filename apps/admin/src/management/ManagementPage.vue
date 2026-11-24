<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
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
    case 'failures':
      return ['重试原事件'];
    default:
      return [];
  }
});
watch(
  [key, () => route.params.item, isAdmin],
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
    :show-id="true"
    :base="'/manage/' + key"
    :selected="String(route.params.item || '')"
  >
    <template #detail>
      <form
        v-if="actions.length"
        class="preview-form management-form"
        @submit.prevent="message = '当前为示例预览，' + action + '尚未提交。'"
      >
        <label>操作<UiSelect label="操作" v-model="action" :options="actions" /></label>
        <label>处理意见<textarea v-model="reason" /></label
        ><button class="primary">预览操作</button>
      </form>
      <p v-if="message" role="status">{{ message }}</p>
    </template>
  </PreviewRecords>
</template>

<style scoped>
@media (min-width: 1024px) {
  .management-form {
    max-width: 42rem;
  }
  .management-form label {
    grid-template-columns: 5em minmax(0, 1fr);
    align-items: start;
    gap: 20px;
  }
  .management-form button {
    margin-left: calc(5em + 20px);
  }
}
</style>