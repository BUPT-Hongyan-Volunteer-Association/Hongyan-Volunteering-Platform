<script setup lang="ts">
import { ref } from 'vue';
import { ApiError, changeOwnPassword, passwordRequirement, type Profile } from '@hongyan/contracts';
import UiIcon from '@hongyan/ui/UiIcon.vue';

defineProps<{ profile: Profile }>();
const current = ref(''), next = ref('');
const busy = ref(false), notice = ref(''), error = ref('');

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    notice.value = '';
    await changeOwnPassword(current.value, next.value);
    current.value = next.value = '';
    notice.value = '密码已更改';
  } catch (e) {
    error.value = e instanceof ApiError && e.status ? e.message : '改密结果未确认，请重新登录核对';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="reading-area">
    <RouterLink class="back-link" to="/mine"><UiIcon name="ArrowLeft" />返回我的</RouterLink>
    <h1>账号管理</h1>
    <dl class="detail-fields">
      <dt>姓名</dt>
      <dd>{{ profile.display_name }}</dd>
      <dt>登录账号</dt>
      <dd>{{ profile.username }}</dd>
      <template v-if="profile.student"
        ><dt>学号</dt>
        <dd>{{ profile.student.student_no }}</dd></template
      >
    </dl>
    <form class="password-form" @submit.prevent="submit">
      <h2>更改密码</h2>
      <fieldset :disabled="busy">
        <label>原密码<input v-model="current" type="password" autocomplete="current-password" required /></label>
        <label>新密码<input v-model="next" type="password" autocomplete="new-password" aria-describedby="password-rule" required /></label>
        <small id="password-rule">{{ passwordRequirement }}</small>
      </fieldset>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <button class="primary" :disabled="busy">{{ busy ? '正在处理…' : '保存新密码' }}</button>
    </form>
  </div>
</template>

<style scoped>
.password-form { display: grid; gap: 12px; max-width: 26rem; margin-top: 24px; }
.password-form h2, .password-form p { margin: 0; }
fieldset { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 0; border: 0; }
label { display: grid; gap: 4px; }
small { color: var(--muted); }
button { justify-self: start; }
</style>
