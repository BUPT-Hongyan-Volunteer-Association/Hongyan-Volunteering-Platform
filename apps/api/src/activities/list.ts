import type { ActivityWindow } from './filters.js';
import type { Activity as View } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Database, Tx } from '../database.js';
import { denied, invalid } from '../http.js';
import { eligibleOrganizer, includeView, pagination, project, workingRevision, type PageRow } from './read.js';
import { matchesCampus, serviceWindow } from '@hongyan/contracts/activity';

type Query = Record<string, string>;
type Scope = 'public' | 'working' | 'published';
type ListOptions = {
  studentId?: string;
  showOwnerAvailability?: boolean;
  range: ActivityWindow | undefined;
  outsideWindow?: (start: number, end: number) => void;
};

function contentFilter(
  q: Query,
  range: ActivityWindow | undefined,
  outsideWindow: ListOptions['outsideWindow'],
) {
  return (a: View) => {
    if (q.status && a.status !== q.status) return false;
    if (q.q && ![a.title, a.activity_code].some(value => value.includes(q.q))) return false;
    if (q.campus && !matchesCampus(a.campus, q.campus)) return false;
    if (q.registration_phase && a.registration_phase !== q.registration_phase) return false;
    if (q.is_ongoing && a.is_ongoing !== (q.is_ongoing === 'true')) return false;
    if (!range) return true;
    const period = serviceWindow(a.schedule);
    if (!period) return false;
    if (period.start < range.to && period.end > range.from) return true;
    outsideWindow?.(period.start, period.end);
    return false;
  };
}

/**
 * 先按权限与筛选限定范围，再在同一数据库快照内计数、取页。
 * 列表与日程共用这一实现，保证同一范围、窗口和筛选下结果一致。
 */
export async function activityViews(
  tx: Tx,
  where: Prisma.ActivityWhereInput,
  scope: Scope,
  q: Query,
  { studentId, showOwnerAvailability = false, range, outsideWindow }: ListOptions,
  onView?: (view: View, matches: boolean, row: PageRow) => void,
) {
  const { page, page_size, skip } = pagination(q);
  const matches = contentFilter(q, range, outsideWindow);
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
          ? { where: { student_id: studentId }, select: { status: true, item_id: true } }
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
        ...row,
        revisions: byActivity.get(row.id) ?? [],
        reviews: row.reviews ?? [],
      };
      if (q.review_status && workingRevision(data)?.revision_state !== q.review_status)
        continue;
      const view = project(data, scope, now);
      if (!view) continue;
      const matched = matches(view);
      onView?.(view, matched, data);
      if (!matched) continue;
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
}

export async function activityPage(
  db: Database,
  where: Prisma.ActivityWhereInput,
  scope: Scope,
  q: Query,
  options: ListOptions,
) {
  const { items, total, page, page_size } = await db.$transaction(
    tx => activityViews(tx, where, scope, q, options),
    { isolationLevel: 'RepeatableRead' },
  );
  return { items, total, page, page_size };
}
