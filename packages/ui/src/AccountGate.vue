<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  ApiError,
  changeOwnPassword,
  getProfile,
  login,
  logout,
  openSession,
  passwordRequirement,
  writeHeaders,
  type Profile,
} from '@hongyan/contracts';

import BrandName from './BrandName.vue';
import AccountIdentity from './AccountIdentity.vue';
import UiIcon from './UiIcon.vue';

const showPassword = ref(false);
const props = defineProps<{ admin?: boolean }>();
const stage = ref<'loading' | 'failed' | 'login' | 'change' | 'ready'>('loading');
const profile = ref<Profile>();
const username = ref(''),
  password = ref(''),
  next = ref(''),
  message = ref(''),
  busy = ref(false);
async function restore() {
  stage.value = 'loading';
  profile.value = undefined;
  message.value = '';
  try {
    await openSession();
    profile.value = (await getProfile({ throwOnError: true })).data.data;
    stage.value = 'ready';
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) stage.value = 'login';
    else if (e instanceof ApiError && e.body?.code === 'password_change_required')
      stage.value = 'change';
    else {
      stage.value = 'failed';
      message.value = e instanceof Error ? e.message : '无法读取身份';
    }
  }
}
async function submit(action: 'login' | 'change' | 'logout') {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    if (action === 'login')
      await login({
        headers: writeHeaders(),
        body: { username: username.value, password: password.value },
        throwOnError: true,
      });
    if (action === 'change') await changeOwnPassword(password.value, next.value);
    if (action === 'logout') await logout({ headers: writeHeaders(), throwOnError: true });
    showPassword.value = false;
    password.value = '';
    next.value = '';
    await restore();
  } catch (e) {
    if (action === 'login' && e instanceof ApiError && e.body?.code === 'unauthorized') {
      await restore();
      if (stage.value === 'login') message.value = '登录页面已过期，会话已更新，请再次登录';
    } else if (action === 'login' && e instanceof ApiError && e.body?.code === 'invalid_credentials') {
      message.value = '登录失败，请核对账号和密码。如果你刚办理过凭证重置，旧密码已失效，请联系办理老师确认发放进度';
    } else {
      if (e instanceof ApiError && e.status === 401 && action !== 'login') await restore();
      message.value = e instanceof Error ? e.message : '请求失败';
    }
  } finally {
    busy.value = false;
  }
}
function expired() {
  if (stage.value === 'ready' || stage.value === 'change') void restore();
}
async function refreshIdentity() {
  if (stage.value !== 'ready' || busy.value) return;
  const current = profile.value?.account_id;
  try {
    const result = (await getProfile({ throwOnError: true })).data.data;
    if (stage.value === 'ready' && profile.value?.account_id === current) profile.value = result;
  } catch (e) {
    if (e instanceof ApiError && e.body?.code === 'password_change_required') await restore();
  }
}
onMounted(() => {
  window.addEventListener('focus', refreshIdentity);
  window.addEventListener('hongyan-roles-changed', refreshIdentity);
  window.addEventListener('hongyan-session-expired', expired);
  void restore();
});
onUnmounted(() => {
  window.removeEventListener('focus', refreshIdentity);
  window.removeEventListener('hongyan-roles-changed', refreshIdentity);
  window.removeEventListener('hongyan-session-expired', expired);
});
</script>

<template>
  <template v-if="stage === 'ready' && profile">
    <template
      v-if="props.admin && !profile.roles.some((r) => r === 'reviewer' || r === 'tech_admin')"
    >
      <header class="auth-top">
        <BrandName /><AccountIdentity
          :name="profile.display_name"
          :busy="busy"
          @logout="submit('logout')"
        />
      </header>
      <main class="auth-state">
        <UiIcon name="Lock" />
        <h1>后台访问受限</h1>
        <p role="alert">当前账号无后台权限</p>
      </main>
    </template>
    <slot
      v-else
      :key="profile.account_id"
      :profile="profile"
      :restore="restore"
      :busy="busy"
      :logout="() => submit('logout')"
    />
    <p v-if="message" class="account-error" role="alert">{{ message }}</p>
  </template>
  <div v-else class="auth-page">
    <header class="auth-top">
      <BrandName /><span>{{ admin ? '审核后台' : '学生与负责人端' }}</span>
    </header>
    <main v-if="stage === 'loading' || stage === 'failed'" class="auth-state">
      <UiIcon :name="stage === 'loading' ? 'Clock' : 'Connection'" />
      <p v-if="stage === 'loading'" role="status">正在读取会话…</p>
      <template v-else
        ><h1>连接失败</h1>
        <p role="alert">{{ message }}</p>
        <button type="button" @click="restore"><UiIcon name="Refresh" />重试</button></template
      >
    </main>
    <main v-else class="auth-main">
      <aside class="access-info">
        <h2>{{ admin ? '审核后台' : '学生与负责人入口' }}</h2>
        <div class="access-row">
          <UiIcon :name="admin ? 'Stamp' : 'User'" />
          <div>
            <h3>{{ admin ? '审核账号' : '学生账号' }}</h3>
            <p>
              {{
                admin
                  ? '使用分配的审核员或技术管理员账号登录'
                  : '使用十位学号登录，保留开头的零'
              }}
            </p>
          </div>
        </div>
        <div class="access-row">
          <UiIcon :name="admin ? 'Files' : 'Key'" />
          <div>
            <h3>{{ admin ? '审核范围' : '首次登录' }}</h3>
            <p>
              {{
                admin
                  ? '在待办中查看活动版本，并进入对应审核页面'
                  : '初始密码为学号后六位，首次登录后需设置新密码'
              }}
            </p>
          </div>
        </div>
        <div v-if="!admin" class="access-row">
          <UiIcon name="Calendar" />
          <div>
            <h3>活动负责人</h3>
            <p>登录后可从导航栏直接管理活动</p>
          </div>
        </div>
      </aside>
      <form class="credentials" @submit.prevent="submit(stage === 'change' ? 'change' : 'login')">
        <h1>{{ stage === 'login' ? '登录' : '首次登录，请修改密码' }}</h1>
        <label v-if="stage === 'login'" class="form-label"
          >账号
          <span class="input-with-icon"
            ><UiIcon name="User" /><input
              v-model="username"
              required
              :placeholder="admin ? '输入后台账号' : '输入学号或平台账号'"
              autocomplete="username"
          /></span>
        </label>
        <div class="form-label">
          <label for="hy-password">当前密码</label>
          <div class="input-with-icon">
            <UiIcon name="Lock" /><input
              id="hy-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              required
              placeholder="输入当前密码"
              autocomplete="current-password"
            />
            <button
              type="button"
              class="password-eye icon-button quiet"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              :aria-pressed="showPassword"
              @click="showPassword = !showPassword"
            >
              <UiIcon :name="showPassword ? 'Hide' : 'View'" />
            </button>
          </div>
        </div>
        <label v-if="stage === 'change'" class="form-label"
          >新密码
          <span class="input-with-icon"
            ><UiIcon name="Key" /><input
              v-model="next"
              type="password"
              required
              autocomplete="new-password"
              placeholder="设置新密码"
              aria-describedby="pw-rule"
          /></span>
          <small id="pw-rule">{{ passwordRequirement }}</small>
        </label>
        <p v-if="message" role="alert">{{ message }}</p>
        <button class="primary auth-submit" :disabled="busy" :aria-busy="busy">
          {{ busy ? '正在处理…' : stage === 'login' ? '登录' : '保存新密码'
          }}<UiIcon name="Right" />
        </button>
        <button v-if="stage === 'change'" type="button" :disabled="busy" @click="submit('logout')">
          退出
        </button>
      </form>
    </main>
  </div>
</template>
<style scoped>
.auth-page {
  min-height: 100vh;
  border-top: 4px solid var(--brand);
}
.auth-top {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px clamp(20px, 5vw, 80px);
  border-bottom: 1px solid var(--line);
}
.auth-top > span {
  padding-left: 18px;
  border-left: 1px solid var(--field-line);
  color: var(--muted);
  font-size: 14px;
}
.auth-main {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  max-width: 940px;
  margin: clamp(52px, 11vh, 112px) auto;
  padding: 0 28px;
  column-gap: clamp(40px, 7vw, 96px);
}
.access-info {
  border-top: 3px solid var(--brand);
  padding: 28px;
  background: var(--surface);
}
.access-info h2 {
  font-size: 22px;
  margin-bottom: 26px;
}
.access-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-top: 22px;
}
.access-row > .ui-icon {
  margin-top: 3px;
  color: var(--brand);
}
.access-row h3 {
  font-size: 15px;
  margin: 0;
}
.access-row p {
  color: var(--muted);
  font-size: 14px;
  margin: 3px 0 0;
}
.credentials {
  min-width: 0;
  display: grid;
  gap: 18px;
}
.credentials h1 {
  margin-bottom: 3px;
}
.form-label {
  display: grid;
  gap: 6px;
  font-size: 14px;
  font-weight: 550;
}
.form-label small {
  color: var(--muted);
  font-weight: 400;
}
.input-with-icon {
  position: relative;
  display: flex;
  align-items: center;
}
.input-with-icon > .ui-icon {
  position: absolute;
  left: 13px;
  color: var(--muted);
  width: 17px;
}
.input-with-icon input {
  width: 100%;
  min-height: 44px;
  padding: 10px 42px 10px 39px;
  font-weight: 400;
}
.password-eye {
  position: absolute;
  right: 2px;
  border: 0;
  color: var(--muted);
}
.auth-submit {
  min-height: 44px;
  margin-top: 6px;
}
.auth-state {
  margin: 12vh auto;
  text-align: center;
  max-width: 28rem;
  padding: 20px;
}
.auth-state > .ui-icon {
  width: 30px;
  height: 30px;
  color: var(--brand);
}
.auth-state h1 {
  margin: 12px 0;
}
.account-error {
  position: fixed;
  top: 58px;
  right: 16px;
  z-index: 5;
  max-width: min(400px, 90vw);
}
@media (max-width: 700px) {
  .auth-top {
    min-height: 58px;
    gap: 10px;
  }
  .auth-top > span {
    padding-left: 10px;
    font-size: 12px;
  }
  .auth-main {
    max-width: 480px;
    margin: 30px auto;
    padding: 0 20px;
    display: flex;
    flex-direction: column-reverse;
    align-items: stretch;
    gap: 32px;
  }
  .access-info {
    padding: 16px 18px;
    border-top-width: 2px;
  }
  .access-info h2 {
    font-size: 16px;
    margin-bottom: 12px;
  }
  .access-row {
    margin-top: 12px;
    gap: 10px;
  }
  .access-row h3 {
    font-size: 14px;
  }
}
</style>
