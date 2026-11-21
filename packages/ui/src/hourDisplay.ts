import { computed, shallowRef } from 'vue';
import { type ApiError, type HourBatch, type HourRow } from '@hongyan/contracts';
export { message, noAccess, usePageRead as useHourRead } from './usePageRead';

export const statuses: Record<HourBatch['status'], string> = {
  validating: '校验中', invalid: '内容有误', ready: '校验完成', failed: '系统校验失败',
  pending_review: '待审核', approved: '已批准', rejected: '已驳回',
};
export const actions: Record<HourRow['action'], string> = {
  add: '新增', skip_identical: '重复跳过', correct: '更正', void: '撤销', review_only: '仅更新违纪信息', error: '错误',
};
export const modes: Record<HourBatch['mode'], string> = { new: '新增', correction: '更正', void: '撤销' };
export const misconductLabels = { reported: '有', none: '无', not_provided: '未提供' };
export const fields: Record<string,string> = { student_no:'学号', student_name:'姓名', activity_code:'活动编号',
  service_date:'服务日期', credited_hours:'认证时长', remark:'备注', misconduct_reported:'是否有违纪情况', file:'工作簿' };
export const signed = (value?: string) => value === undefined ? '—' : Number(value) > 0 ? '+' + value : value;
export const beijing = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
}) : '—';

type ReviewWarnings = Pick<HourBatch, 'warnings' | 'warning_snapshot_hash'>;

export function useReviewWarnings(current: () => ReviewWarnings | undefined) {
  const revised = shallowRef<ReviewWarnings>();
  const snapshot = computed(() => revised.value ?? current());
  return {
    warnings: computed(() => snapshot.value?.warnings ?? []),
    hash: computed(() => snapshot.value?.warning_snapshot_hash),
    reset() { revised.value = undefined; },
    refreshFrom(error: ApiError) {
      const context = error.body?.context;
      if (error.status !== 409 || error.body?.code !== 'warning_review_required' ||
        !context?.warnings || !context.warning_snapshot_hash) return false;
      revised.value = { warnings: context.warnings, warning_snapshot_hash: context.warning_snapshot_hash };
      return true;
    },
  };
}
