import type { Activity as View } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../database.js';
import { denied, invalid } from '../http.js';
import { eligibleOrganizer, includeView, pagination, project, workingRevision, type PageRow } from './read.js';
import { matchesCampus } from '@hongyan/contracts/activity';
import { slots } from './schedule.js';

type Query = Record<string, string>;
type Scope = 'public' | 'working' | 'published';
type ListOptions = { studentId?: string; showOwnerAvailability?: boolean };

export function contentFilter(q: Query) {
  const from = Date.parse(q.from),
    to = Date.parse(q.to);
  if (
    (q.from !== undefined || q.to !== undefined) &&
    !(Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= 31 * 86400000)
  )
    invalid('from', '日期窗口须成对填写，最长 31 天');
  if (q.is_ongoing && !['true', 'false'].includes(q.is_ongoing))
    invalid('is_ongoing', '进行中筛选值无效');
  return (a: View) =>
    (!q.q || [a.title, a.activity_code].some((v) => v.includes(q.q))) &&
    (!q.campus || matchesCampus(a.campus, q.campus)) &&
    (!q.registration_phase || a.registration_phase === q.registration_phase) &&
    (!q.is_ongoing || a.is_ongoing === (q.is_ongoing === 'true')) &&
    (!q.from ||
      slots(a.schedule).some((s) => Date.parse(s.starts_at) < to && Date.parse(s.ends_at) > from));
}

/**
 * 先按权限与筛选限定范围，再在同一数据库快照内计数、取页。
 * 列表与日程共用这一实现，保证同一范围、窗口和筛选下结果一致。
 */
export async function activityViews(
  db: Database,
  where: Prisma.ActivityWhereInput,
  scope: Scope,
  q: Query,
  { studentId, showOwnerAvailability = false }: ListOptions = {},
  onMatch?: (view: View) => void,
) {
  const { page, page_size, skip } = pagination(q);
  const matches = contentFilter(q);
  const derived = !!(
    q.q ||
    q.campus ||
    q.registration_phase ||
    q.is_ongoing ||
    q.from ||
    q.review_status
  );
  const management = scope !== 'public';
  const now = new Date();
  const availableOwner: Prisma.ActivityMemberWhereInput = { member_role: 'owner', account: eligibleOrganizer(now) };
  if (q.owner_unavailable !== undefined) {
    if (!showOwnerAvailability) denied();
    if (!['true', 'false'].includes(q.owner_unavailable)) invalid('owner_unavailable', '待接管筛选值无效');
    const members = q.owner_unavailable === 'true' ? { none: availableOwner } : { some: availableOwner };
    where = { AND: [where, { members }] };
  }
  return db.$transaction(
    async (tx) => {
      const items: View[] = [];
      let total = derived ? 0 : await tx.activity.count({ where });
      const take = derived ? 100 : page_size;
      let cursor: string | undefined;
      // Simple lists can go straight to the requested page. Derived filters must count every match.
      while (derived || skip < total) {
        const rows = await tx.activity.findMany({
          where,
          orderBy: [{ activity_code: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : { skip: derived ? 0 : skip }),
          include: {
            members: includeView.members,
            _count: showOwnerAvailability && { select: { members: { where: availableOwner } } },
            reviews: management && {
              where: { status: 'pending' },
              select: { id: true, status: true },
            },
            registrations: studentId
              ? { where: { student_id: studentId }, select: { status: true } }
              : false,
          },
        });
        if (!rows.length) break;
        const refs = rows.flatMap((row) => {
          const versions = new Set([
            row.published_revision,
            ...(management ? [row.working_revision] : []),
          ]);
          return [...versions]
            .filter((v) => v !== null)
            .map((revision) => ({ activity_id: row.id, revision }));
        });
        const snapshots = await tx.activityRevision.findMany({ where: { OR: refs } });
        const byActivity = new Map<string, typeof snapshots>();
        for (const revision of snapshots) {
          const group = byActivity.get(revision.activity_id);
          if (group) group.push(revision);
          else byActivity.set(revision.activity_id, [revision]);
        }
        for (const row of rows) {
          const data: PageRow = {
            id: row.id,
            activity_code: row.activity_code,
            status: row.status,
            version: row.version,
            working_revision: row.working_revision,
            published_revision: row.published_revision,
            members: row.members,
            revisions: byActivity.get(row.id) ?? [],
            reviews: row.reviews ?? [],
            ...(row.registrations && { registrations: row.registrations }),
          };
          if (q.review_status && workingRevision(data)?.revision_state !== q.review_status)
            continue;
          const view = project(data, scope, now);
          if (!view || !matches(view)) continue;
          onMatch?.(view);
          if (derived) {
            total++;
            if (total <= skip || items.length === page_size) continue;
          }
          items.push(showOwnerAvailability ? { ...view, owner_unavailable: row._count.members === 0 } : view);
        }
        if (!derived || rows.length < take) break;
        cursor = rows[rows.length - 1].id;
      }
      return { items, total, page, page_size, now };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export async function activityPage(
  db: Database,
  where: Prisma.ActivityWhereInput,
  scope: Scope,
  q: Query,
  options: ListOptions = {},
) {
  const { items, total, page, page_size } = await activityViews(db, where, scope, q, options);
  return { items, total, page, page_size };
}
