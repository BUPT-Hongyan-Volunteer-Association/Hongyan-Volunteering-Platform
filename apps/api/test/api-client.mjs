import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function browser(base) {
  let cookie = '',
    csrf = '';
  async function request(path, { method = 'GET', body, key, form, omitCsrf = false, csrfToken = csrf } = {}) {
    const headers = { Cookie: cookie };
    if (!omitCsrf) headers['X-CSRF-Token'] = csrfToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(base + path, { method, headers, body: form ?? JSON.stringify(body) });
    const fresh = response.headers.get('set-cookie');
    if (fresh) cookie = fresh.split(';')[0];
    const payload = await response.json();
    if (path === '/auth/csrf' && response.ok) csrf = payload.data.csrf_token;
    return { status: response.status, ...payload };
  }
  async function signIn(username, password, newPassword) {
    await request('/auth/csrf');
    const login = await request('/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.status, 200, JSON.stringify(login));
    await request('/auth/csrf');
    if (newPassword) {
      assert.equal((await request('/me')).code, 'password_change_required');
      assert.equal(
        (
          await request('/auth/change-password', {
            method: 'POST',
            body: { current_password: password, new_password: newPassword },
          })
        ).status,
        200,
      );
      await request('/auth/csrf');
    }
    return login;
  }
  function upload(path, bytes, filename = '学生建档导入模板.xlsx', key = randomUUID()) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
    return request(path, { method: 'POST', key, form });
  }
  const write = (method, path, body, key = randomUUID()) => request(path, { method, body, key });
  const raw = (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...options.headers,
      },
    });
  return { request, signIn, write, raw, upload };
}
