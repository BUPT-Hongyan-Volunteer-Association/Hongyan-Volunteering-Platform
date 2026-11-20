import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from 'vue';
import { ApiError, type HourBatch, type HourRow } from '@hongyan/contracts';

export const statuses: Record<HourBatch['status'], string> = {
  validating: '校验中', invalid: '内容有误', ready: '校验完成', failed: '系统校验失败',
  pending_review: '待审核', approved: '已批准', rejected: '已驳回',
};
export const actions: Record<HourRow['action'], string> = {
  add: '新增', skip_identical: '重复跳过', correct: '更正', void: '撤销', review_only: '仅更新违纪信息', error: '错误',
};
export const fields: Record<string,string> = { student_no:'学号', student_name:'姓名', activity_code:'活动编号',
  service_date:'服务日期', credited_hours:'认证时长', remark:'备注', misconduct_reported:'是否有违纪情况', file:'工作簿' };
export const signed = (value?: string) => value === undefined ? '—' : Number(value) > 0 ? '+' + value : value;
export const message = (error: unknown) => error instanceof Error ? error.message : '未能读取数据，请重试。';
export const noAccess = (error: unknown) => error instanceof ApiError && [401,403,404].includes(error.status ?? 0);
export const beijing = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
}) : '—';

export function useHourRead<T>(source: WatchSource, read: (signal: AbortSignal) => Promise<T>, denied?: () => void) {
  const data = shallowRef<T>(), error = ref(''), loading = ref(false);
  let active: AbortController | undefined;
  async function refresh(clear = true) {
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
  watch(source, () => void refresh(), { immediate:true, flush:'sync' });
  onScopeDispose(() => active?.abort());
  return { data, error, loading, refresh };
}
