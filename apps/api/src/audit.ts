import { json, type Tx } from './activities/workflow.js';

const sensitiveKey = /password|token|secret|session|credential|contents|attachment|file_data/i;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? '[已脱敏]' : redact(item),
    ]));
  return value;
}

export async function audit(
  tx: Tx,
  event: { actor_id: string; action: string; resource_type: string; resource_id: string;
    reason?: string; before?: unknown; after?: unknown },
) {
  const { before, after, ...fields } = event;
  await tx.auditEvent.create({
    data: { ...fields, ...(before !== undefined && { before: json(redact(before)) }),
      ...(after !== undefined && { after: json(redact(after)) }) },
  });
}
