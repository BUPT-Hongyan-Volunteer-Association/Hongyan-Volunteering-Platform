import { client } from './generated/client.gen';
import { getCsrf } from './generated/sdk.gen';
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
    super(body?.message ?? '未能连接平台服务，请重试。');
  }
}

client.interceptors.error.use((error, response) =>
  new ApiError(response?.status, isContractError(error) ? error : undefined));

/** 两端启动与重试共用的匿名会话。令牌只留在请求层内存中。 */
export async function openSession() {
  csrfToken = undefined;
  const { data } = await getCsrf({ throwOnError: true, cache: 'no-store' });
  const session = data?.data;
  if (!session?.csrf_token || !Number.isFinite(Date.parse(session.expires_at)) || !data.request_id) {
    throw new Error('会话响应格式有误，请重新连接。');
  }
  csrfToken = session.csrf_token;
  return { expiresAt: session.expires_at };
}

export * from './generated/sdk.gen';
export type * from './generated/types.gen';

export function writeHeaders() {
  if (!csrfToken) throw new Error('会话尚未建立，请刷新后重试');
  return { 'X-CSRF-Token': csrfToken };
}
