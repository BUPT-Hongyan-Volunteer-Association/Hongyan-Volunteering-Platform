import type { HourReviewDecision, HourWarning } from '@hongyan/contracts/types';
import { stable } from '../activities/workflow.js';
import { BusinessError, invalid } from '../http.js';
import { digest } from './batch-data.js';
import { hours } from './values.js';

export function hourWarnings(
  student_id: string, service_date: string, row_number: number, value: number,
  duration: number | null, projected: number, explanation: string,
) {
  const warnings: HourWarning[] = [];
  const warn = (code: HourWarning['code'], message: string, amount: Partial<HourWarning>) => {
    warnings.push({
      warning_id: [code, student_id, service_date, row_number].join(':'),
      code, student_id, service_date, row_numbers: [row_number], message,
      ...(explanation && { explanation }), ...amount,
    });
  };
  if (duration !== null && value * 360000 > duration) {
    warn('exceeds_planned_hours', '预计时长超过当天计划覆盖时长', { planned_hours: String(duration / 3600000) });
  }
  if (projected > 240) {
    warn('daily_total_exceeds_24', '该学生跨活动当日预计超过 24 小时', { projected_daily_hours: hours(projected) });
  }
  return warnings;
}

export function warningSnapshot(warnings: HourWarning[]) {
  return { warnings, warning_snapshot_hash: digest(stable(warnings)) };
}

export function acceptWarnings(input: HourReviewDecision, frozenHash: string, warnings: HourWarning[]) {
  const snapshot = warningSnapshot(warnings);
  if (input.warning_snapshot_hash !== snapshot.warning_snapshot_hash
    && (input.warning_snapshot_hash !== undefined || warnings.length > 0
      || frozenHash !== snapshot.warning_snapshot_hash)) {
    throw new BusinessError(409, 'warning_review_required', '警告已变化，请复核最新结果', undefined, snapshot);
  }
  if (warnings.length && !input.reason?.trim()) invalid('reason', '请填写警告接受依据');
  return snapshot;
}
