<script setup lang="ts">
import HourLedger from '@hongyan/ui/HourLedger.vue';
</script>
<template>
  <RouterLink class="back-link" to="/mine">返回我的</RouterLink>
  <HourLedger :scope="{ type: 'my_hours' }" title="我的时长">
    <template #links><RouterLink class="button compact" to="/mine/feedback">本人记录与反馈</RouterLink></template>
    <template #actions="{ row }">
      <RouterLink class="button compact" v-if="row.status === 'current'" :to="{ path: '/mine/feedback', query: { target: row.id, kind: 'hours' } }">反馈这笔时长</RouterLink>
    </template>
  </HourLedger>
</template>
