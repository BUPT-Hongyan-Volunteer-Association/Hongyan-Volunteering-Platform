import type { Prisma } from '../generated/prisma/client.js';
import { denied, invalid } from '../http.js';
import { parseCalendarDate } from './schedule.js';

type Query = Record<string, string>;
export type ActivityWindow = { from: number; to: number };
const statuses = ['draft', 'pending_review', 'published', 'cancelled', 'completed', 'archived'];
const publicStatuses = ['published', 'cancelled', 'completed'];
const phases = ['not_open', 'open', 'closed', 'unavailable'];
const reviewStatuses = ['draft', 'pending_review', 'approved', 'rejected', 'withdrawn', 'cancelled'];
const day = 86_400_000;
const dateTime = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function windowBound(q: Query, field: 'from' | 'to') {
  const value = q[field];
  const match = typeof value === 'string' && dateTime.exec(value);
  const time = match && parseCalendarDate(match[1]) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) invalid(field, '请填写带时区的有效日期时间');
  return time;
}

function dateRange(q: Query) {
  const from = windowBound(q, 'from');
  const to = windowBound(q, 'to');
  if (!(from < to)) invalid('to', '结束时刻必须晚于开始时刻');
  if (to - from > 31 * day) invalid('to', '日期窗口最长 31 天');
  return { from, to };
}

export function parseActivityFilters(q: Query, management: boolean, requiredWindow: true): ActivityWindow;
export function parseActivityFilters(q: Query, management: boolean, requiredWindow?: false): ActivityWindow | undefined;
export function parseActivityFilters(q: Query, management: boolean, requiredWindow = false) {
  if (!management && (q.review_status !== undefined || q.owner_account_id !== undefined || q.revision_scope === 'working')) denied();
  if (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 100)) invalid('q', '搜索词过长或格式无效');
  if (q.campus !== undefined && typeof q.campus !== 'string') invalid('campus', '校区筛选值无效');
  if (q.status !== undefined && !(management ? statuses : publicStatuses).includes(q.status)) invalid('status', '活动状态筛选值无效');
  if (q.registration_phase !== undefined && !phases.includes(q.registration_phase)) invalid('registration_phase', '报名阶段筛选值无效');
  if (q.review_status !== undefined && !reviewStatuses.includes(q.review_status)) invalid('review_status', '审核状态筛选值无效');
  if (q.revision_scope !== undefined && !['working', 'published'].includes(q.revision_scope)) invalid('revision_scope', '版本范围无效');
  if (q.owner_account_id !== undefined && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(q.owner_account_id)) invalid('owner_account_id', '负责人编号无效');
  if (q.is_ongoing !== undefined && !['true', 'false'].includes(q.is_ongoing)) invalid('is_ongoing', '进行中筛选值无效');
  if (requiredWindow || q.from !== undefined || q.to !== undefined) return dateRange(q);
}

/** 本人列表包含本人的全部已录取且有获批版本的活动，公开列表默认展示已发布活动。 */
export function publishedActivityFilter(scope: 'public' | 'mine', status?: string, studentId?: string): Prisma.ActivityWhereInput {
  return {
    published_revision: { not: null },
    status: status ?? (scope === 'public' ? 'published' : undefined),
    ...(scope === 'mine' && { registrations: { some: { student_id: studentId ?? { in: [] }, status: 'accepted' } } }),
  };
}
