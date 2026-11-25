<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import HourLedger from '@hongyan/ui/HourLedger.vue';
const route = useRoute(), router = useRouter();
const studentsList = computed(() => {
  const origin = route.query.students;
  const validOrigin = typeof origin === 'string' && /^\/manage\/students(?:\?|$)/.test(origin);
  return {
    path: '/manage/students', query: validOrigin ? router.resolve(origin).query : {},
    state: { returnFocus: 'hours-' + route.params.item },
  };
});
</script>
<template>
  <RouterLink class="back-link" :to="studentsList">返回学生档案</RouterLink>
  <HourLedger :scope="{ type: 'admin_student_hours', student_id: String(route.params.item) }"
    :title="route.query.name ? String(route.query.name) + ' · 时长台账' : '学生时长台账'" batch-base="/hours" group-base="/manage/corrections" />
</template>
