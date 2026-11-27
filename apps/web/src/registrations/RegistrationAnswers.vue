<script setup lang="ts">
import { computed } from 'vue';
import type { Registration } from '@hongyan/contracts';
import { localDateTime } from '@hongyan/ui/activityDisplay';

const props = defineProps<{ registration: Registration }>();
const versions = computed(() => [
  { current: true, submitted_at: props.registration.submitted_at, answers: props.registration.answers ?? [] },
  ...(props.registration.answer_history ?? []).map(entry => ({ ...entry, current: false })),
].filter(entry => entry.answers.length));
</script>
<template>
  <section v-if="versions.length" class="registration-answers" aria-label="报名答卷">
    <details v-for="(entry, index) in versions" :key="entry.submitted_at + index" :open="entry.current">
      <summary>{{ entry.current ? '报名答卷' : '历史答卷 · ' + localDateTime(entry.submitted_at) }}</summary>
      <dl><template v-for="answer in entry.answers" :key="answer.question_id">
        <dt>{{ answer.title }}</dt><dd>{{ answer.text || answer.labels?.join('、') || '未填写' }}</dd>
      </template></dl>
    </details>
  </section>
</template>
<style scoped>
.registration-answers { margin-block: 12px; }
summary { cursor: pointer; font-weight: 600; padding-block: 8px; }
dd { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
