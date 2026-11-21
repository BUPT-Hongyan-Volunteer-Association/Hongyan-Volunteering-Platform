<script setup lang="ts">
import { useRoute } from 'vue-router';
import HourLedger from '@hongyan/ui/HourLedger.vue';
const route = useRoute();
</script>
<template>
  <RouterLink class="back-link" to="/manage/students">返回学生档案</RouterLink>
  <HourLedger :scope="{ type: 'admin_student_hours', student_id: String(route.params.item) }"
    :title="route.query.name ? String(route.query.name) + ' · 时长台账' : '学生时长台账'" batch-base="/hours" group-base="/manage/corrections" />
</template>
