<script setup lang="ts">
import type { HourWarning } from '@hongyan/contracts';
defineProps<{ warnings: HourWarning[]; repairPairs?: boolean }>();
</script>
<template>
  <section v-if="warnings.length" class="hour-warnings" aria-label="时长警告">
    <h3>时长警告（{{ warnings.length }} 条）</h3>
    <ul>
      <li v-for="warning in warnings" :key="warning.warning_id">
        <strong v-if="warning.row_numbers">{{ repairPairs ? '第' : '原表第' }} {{ (repairPairs ? warning.row_numbers.map(row => row - 1) : warning.row_numbers).join('、') }} {{ repairPairs ? '对' : '行' }} · </strong>
        {{ warning.service_date }} · {{ warning.message }}
        <span v-if="warning.planned_hours">（计划 {{ warning.planned_hours }} 小时）</span>
        <span v-if="warning.projected_daily_hours">（当日预计 {{ warning.projected_daily_hours }} 小时）</span>
        <small v-if="warning.explanation">{{ warning.explanation }}</small>
      </li>
    </ul>
  </section>
</template>
<style scoped>
.hour-warnings { margin-block: 18px; padding: 10px 14px; background: #fff7d6; border-radius: 6px; }
.hour-warnings ul { margin-block: 8px; padding-inline-start: 19px; max-height: 18rem; overflow: auto; }
.hour-warnings small { display: block; overflow-wrap: anywhere; }
</style>
