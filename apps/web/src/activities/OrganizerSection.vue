<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PreviewRecords from '@hongyan/ui/PreviewRecords.vue';
import { requests } from '../registrations/requests';

const route = useRoute();
const feedback = ref('');
watch([() => route.params.item, () => route.params.id], () => { feedback.value = ''; });
</script>
<template>
  <PreviewRecords title="退出与恢复" :records="requests" :base="'/managed/' + route.params.id + '/requests'"
    :selected="String(route.params.item || '')">
    <template #detail="{ record }">
      <button v-if="record.status === '待处理'" @click="feedback = '示例申请尚待接入，处理决定未提交。'">预览处理决定</button>
    </template>
  </PreviewRecords>
  <p v-if="feedback" role="status">{{ feedback }}</p>
</template>
