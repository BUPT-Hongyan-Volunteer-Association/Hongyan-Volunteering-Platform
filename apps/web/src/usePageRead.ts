import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from 'vue';
import { ApiError } from '@hongyan/contracts';

export const message = (error: unknown) =>
  error instanceof Error ? error.message : '未能读取数据，请重试。';
export const noAccess = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status ?? 0);
export function pageNumber(raw: unknown) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function usePageRead<T>(
  source: WatchSource,
  read: (signal: AbortSignal) => Promise<T>,
  denied?: () => void,
) {
  const data = shallowRef<T>(),
    error = ref(''),
    loading = ref(false);
  let active: AbortController | undefined;
  let disposed = false;
  async function refresh(clear = true) {
    if (disposed) return;
    active?.abort();
    const current = new AbortController();
    active = current;
    if (clear) data.value = undefined;
    loading.value = true;
    error.value = '';
    try {
      const result = await read(current.signal);
      if (!current.signal.aborted) data.value = result;
    } catch (reason) {
      if (!current.signal.aborted) {
        data.value = undefined;
        error.value = message(reason);
        if (noAccess(reason)) denied?.();
      }
    } finally {
      if (!current.signal.aborted) loading.value = false;
    }
  }
  watch(source, () => void refresh(), { immediate: true, flush: 'sync' });
  onScopeDispose(() => {
    disposed = true;
    active?.abort();
  });
  return { data, error, loading, refresh };
}
