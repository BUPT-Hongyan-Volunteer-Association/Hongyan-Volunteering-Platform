<script setup lang="ts">
import UiSelect from '@hongyan/ui/UiSelect.vue';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { sections, type SectionKey } from './sections';
const route = useRoute();
const key = computed(() => route.params.section as SectionKey);
const section = computed(() => sections[key.value]);
const message = ref('');
const action = ref('');
const reason = ref('');
const actions = computed(() => {
  switch (key.value) {
    case 'failures':
      return ['重试原事件'];
    default:
      return [];
  }
});
watch(
  [key, () => route.params.item],
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
    :records="section.records"
    :table-heading="key === 'audit' ? '审计事项' : undefined"
    :status-heading="key === 'audit' ? '状态' : undefined"
    :show-id="key !== 'audit'"
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
