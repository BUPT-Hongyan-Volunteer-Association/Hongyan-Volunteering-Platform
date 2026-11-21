import { getTimeline, type GetTimelineData, type TimelineActivityPage } from '@hongyan/contracts';

export type Scope = 'public' | 'mine' | 'managed' | 'all';
export type RevisionScope = 'working' | 'published';

export type TimelineQuery = {
  scope: Scope;
  revision: RevisionScope;
  from: number;
  to: number;
  page: number;
  q?: string;
  campus?: string;
  phase?: string;
  status?: string;
  ongoing?: string;
  owner?: string;
  pending?: string;
};

/** 按当前范围、窗口和筛选读取一页活动日程；分页与筛选全部由服务端完成。 */
export async function loadTimeline(query: TimelineQuery): Promise<TimelineActivityPage> {
  const params = {
    scope: query.scope,
    from: new Date(query.from).toISOString(),
    to: new Date(query.to).toISOString(),
    revision_scope: query.revision,
    page: query.page,
    page_size: 20,
    ...(query.q && { q: query.q }),
    ...(query.campus && { campus: query.campus }),
    ...(query.phase && { registration_phase: query.phase }),
    ...(query.status && { status: query.status }),
    ...(query.ongoing && { is_ongoing: true }),
    ...(query.owner && { owner_account_id: query.owner }),
    ...(query.pending && { review_status: 'pending_review' }),
  } as GetTimelineData['query'];
  const { data } = await getTimeline({ query: params, throwOnError: true });
  return data.data;
}
