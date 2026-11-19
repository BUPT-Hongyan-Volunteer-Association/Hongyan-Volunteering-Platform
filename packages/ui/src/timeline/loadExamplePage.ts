import {
  listActivities,
  listManagedActivities,
  type TimelineActivity,
  type TimelineActivityPage,
} from '@hongyan/contracts';
import { evaluatedAt, sampleActivity } from './examples';

export type Scope = 'public' | 'mine' | 'managed' | 'all';

/** 仅为两项种子活动生成示例时段。现有列表服务负责角色、成员及获批版本的可见性。 */
export async function loadExamplePage(
  scope: Scope,
  revision: 'working' | 'published',
): Promise<TimelineActivityPage> {
  const items: TimelineActivity[] = [];
  for (const code of ['P2026-0001', 'P2026-0002']) {
    const response =
      scope === 'managed' || scope === 'all'
        ? await listManagedActivities({
            query: { scope, revision_scope: revision, q: code },
            throwOnError: true,
          })
        : await listActivities({ query: { scope, q: code }, throwOnError: true });
    const match = response.data.data.items.find((a) => a.activity_code === code);
    if (match) items.push(sampleActivity(match));
  }
  if (scope === 'public' || scope === 'all') items.push(sampleActivity());
  return { items, total: items.length, page: 1, page_size: 20, state_evaluated_at: evaluatedAt };
}
