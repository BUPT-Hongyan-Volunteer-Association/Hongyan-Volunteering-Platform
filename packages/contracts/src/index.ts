import { client } from './generated/client.gen';
import { changePassword, getCsrf } from './generated/sdk.gen';
import type { Error as ContractError } from './generated/types.gen';

let csrfToken: string | undefined;

client.setConfig({ credentials: 'same-origin' });
client.interceptors.request.use((request) => {
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      && new URL(request.url).origin === window.location.origin) {
    request.headers.set('X-CSRF-Token', csrfToken);
  }
  return request;
});

function isContractError(value: unknown): value is ContractError {
  return typeof value === 'object' && value !== null
    && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string'
    && 'request_id' in value && typeof value.request_id === 'string';
}

export class ApiError extends Error {
  constructor(readonly status: number | undefined, readonly body?: ContractError) {
    super(body?.message ?? '未能连接平台服务，请重试');
  }
}

client.interceptors.error.use((error, response) => {
  if (response?.status === 401 && !response.url.endsWith('/auth/login')) {
    window.dispatchEvent(new Event('hongyan-session-expired'));
  }
  return new ApiError(response?.status, isContractError(error) ? error : undefined);
});

/** 两端启动与重试共用的匿名会话。令牌只留在请求层内存中。 */
export async function openSession() {
  csrfToken = undefined;
  const { data } = await getCsrf({ throwOnError: true, cache: 'no-store' });
  const session = data?.data;
  if (!session?.csrf_token || !Number.isFinite(Date.parse(session.expires_at)) || !data.request_id) {
    throw new Error('会话响应格式有误，请重新连接');
  }
  csrfToken = session.csrf_token;
  return { expiresAt: session.expires_at };
}

export * from './generated/sdk.gen';
export type * from './generated/types.gen';

export const passwordRequirement = '至少 8 个字符，包含英文字母和数字';

export function writeHeaders() {
  if (!csrfToken) throw new Error('会话尚未建立，请刷新后重试');
  return { 'X-CSRF-Token': csrfToken };
}

export async function changeOwnPassword(current_password: string, new_password: string) {
  const { response } = await changePassword({
    body: { current_password, new_password }, headers: writeHeaders(), throwOnError: true,
  });
  csrfToken = response.headers.get('X-CSRF-Token') ?? undefined;
  // 改密已经提交。仅恢复配套会话，不能再次提交改密命令。
  if (!csrfToken) {
    try { await openSession(); }
    catch { window.dispatchEvent(new Event('hongyan-session-expired')); }
  }
}

/** 每个表单实例持有一个命令。原请求结果未知时保留相同的幂等键。 */
export function createCommand() {
  let signature: string | undefined;
  let key: string;
  return {
    headers(operation: string, target: string, body: unknown) {
      const next = JSON.stringify([operation, target, body]);
      if (signature !== next) {
        signature = next;
        key = crypto.randomUUID();
      }
      return { ...writeHeaders(), 'Idempotency-Key': key };
    },
    confirmed() { signature = undefined; },
  };
}
