import type { ActivityRevision } from '../generated/prisma/client.js';

type Versions = {
  working_revision: number;
  published_revision: number | null;
  revisions: ActivityRevision[];
};

export function publishedRevision(row: Versions) {
  return row.revisions.find(
    (r) => r.revision === row.published_revision && r.revision_state === 'approved',
  );
}

export function workingRevision(row: Versions) {
  // The write pointer stays at the latest revision, including after rejection or withdrawal.
  const latest = row.revisions.find((r) => r.revision === row.working_revision);
  if (latest?.revision_state === 'pending_review' || latest?.revision_state === 'draft')
    return latest;
  return publishedRevision(row) ?? latest;
}
