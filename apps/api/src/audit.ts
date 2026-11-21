import { json, type Tx } from './activities/workflow.js';

export async function audit(
  tx: Tx,
  event: { actor_id: string; action: string; resource_type: string; resource_id: string;
    reason?: string; before?: unknown; after?: unknown },
) {
  const { before, after, ...fields } = event;
  await tx.auditEvent.create({
    data: { ...fields, ...(before !== undefined && { before: json(before) }),
      ...(after !== undefined && { after: json(after) }) },
  });
}
