import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function browser(base) {
  let cookie = '',
    csrf = '';
  async function request(path, { method = 'GET', body, key } = {}) {
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    const fresh = response.headers.get('set-cookie');
    if (fresh) cookie = fresh.split(';')[0];
    const payload = await response.json();
    if (path === '/auth/csrf' && response.ok) csrf = payload.data.csrf_token;
    return { status: response.status, ...payload };
  }
  async function signIn(username, password, newPassword) {
    await request('/auth/csrf');
    assert.equal(
      (await request('/auth/login', { method: 'POST', body: { username, password } })).status,
      200,
    );
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
  return { request, signIn, write, raw };
}
