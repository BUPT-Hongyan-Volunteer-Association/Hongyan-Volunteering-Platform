import type { ActivityRevision, ActivityReview } from '../generated/prisma/client.js';
import { stable } from '../database.js';
import { project, publishedRevision, workingRevision, type LoadedActivity } from './read.js';

export function snapshot(r: ActivityRevision) {
  return {
    activity_id: r.activity_id,
    revision: r.revision,
    revision_state: r.revision_state,
    content: r.content,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    ...(r.approved_at && { approved_at: r.approved_at.toISOString() }),
  };
}
function differences(
  before: unknown,
  after: unknown,
  field_path = '',
): { field_path: string; before_value: string; after_value: string }[] {
  if (stable(before) === stable(after)) return [];
  if (
    after &&
    typeof after === 'object' &&
    !Array.isArray(after) &&
    (before == null || (typeof before === 'object' && !Array.isArray(before)))
  ) {
    const left = before as Record<string, unknown> | null,
      right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right)])]
      .sort()
      .flatMap((k) => differences(left?.[k], right[k], field_path ? field_path + '.' + k : k));
  }
  return [{ field_path, before_value: stable(before ?? null), after_value: stable(after ?? null) }];
}
export function reviewView(row: LoadedActivity, r: ActivityReview) {
  const current = row.revisions.find((v) => v.revision === r.revision)!;
  const before = row.revisions.find((v) => v.revision === r.previous_revision);
  return reviewResponse(r, current, before);
}
export function reviewResponse(
  r: ActivityReview,
  current: ActivityRevision,
  before?: ActivityRevision,
) {
  return {
    id: r.id,
    version: r.version,
    activity_id: r.activity_id,
    revision: r.revision,
    status: r.status,
    submitted_by: r.submitted_by,
    created_at: r.created_at.toISOString(),
    ...(r.reviewed_by && { reviewed_by: r.reviewed_by }),
    ...(r.reason && { reason: r.reason }),
    ...(r.reviewed_at && { reviewed_at: r.reviewed_at.toISOString() }),
    snapshot: snapshot(current),
    ...(before && { previous_published_snapshot: snapshot(before) }),
    changes: differences(
      before?.content,
      current.content,
    ),
  };
}
export function detail(row: LoadedActivity) {
  const current = row.reviews.find((r) => r.revision === row.working_revision);
  const working = workingRevision(row)!;
  const published = publishedRevision(row);
  return {
    activity: project(row, 'working', new Date())!,
    working_snapshot: snapshot(working),
    ...(current && { current_review: reviewView(row, current) }),
    ...(published && { published_snapshot: snapshot(published) }),
  };
}
