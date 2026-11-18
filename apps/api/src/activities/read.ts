import type { Activity as View, ActivityInput, ActivitySchedule, ScheduleSlot } from '@hongyan/contracts/types';
import type { Prisma } from '../generated/prisma/client.js';
import type { Actor } from '../auth/session.guard.js';
import { denied, invalid } from '../http.js';

export const staff = (a:Actor) => a.roles.includes('reviewer') || a.roles.includes('tech_admin');
export function managedScope(actor:Actor, scope = staff(actor) ? 'all' : 'managed'): Prisma.ActivityWhereInput {
  if (scope === 'all') { if (!staff(actor)) denied(); return {}; }
  if (scope !== 'managed') invalid('scope','管理范围无效');
  if (!actor.roles.includes('organizer')) denied();
  return { members: { some: { account_id:actor.account_id } } };
}
export const includeView = {
  revisions:true, reviews:true, members:{where:{member_role:'owner'},include:{account:{select:{display_name:true}}}},
} as const;
export type LoadedActivity = Prisma.ActivityGetPayload<{include:typeof includeView}>;
export function slots(s:ActivitySchedule): ScheduleSlot[] {
  if (s.schedule_type==='continuous') return [s];
  if (s.schedule_type==='custom') return s.slots;
  const result=[...(s.additional_slots ?? [])];
  for(let t=Date.parse(s.duration_start_date);t<=Date.parse(s.duration_end_date);t+=86400000) {
    const day=new Date(t).toISOString().slice(0,10);
    if(s.excluded_dates?.includes(day)) continue;
    for(const rule of s.weekly_slots.filter(x=>x.weekday===(new Date(t).getUTCDay() || 7))) {
      const end=new Date(t+rule.end_day_offset*86400000).toISOString().slice(0,10);
      result.push({starts_at:day+'T'+rule.start_time+'+08:00', ends_at:end+'T'+rule.end_time+'+08:00'});
    }
  }
  return result;
}

export function project(row:LoadedActivity, scope:'working'|'published', now:Date, management:boolean):View | null {
  const rev=row.revisions.find(r=>r.revision===(scope==='published'?row.published_revision:row.working_revision));
  if (!rev) return null;
  const input=rev.content as unknown as ActivityInput;
  const times=slots(input.schedule);
  const published=row.revisions.find(r=>r.revision===row.published_revision);
  const live=published ? slots((published.content as unknown as ActivityInput).schedule) : [];
  const t=now.getTime();
  const item:View={...input,id:row.id,version:row.version,activity_code:row.activity_code,status:row.status as View['status'],
    owner_display_name:row.members[0].account.display_name,owner_account_id:row.members[0].account_id,
    starts_at:new Date(Math.min(...times.map(s=>Date.parse(s.starts_at)))).toISOString(),
    ends_at:new Date(Math.max(...times.map(s=>Date.parse(s.ends_at)))).toISOString(),
    registration_phase:row.status!=='published'?'unavailable':t<Date.parse(input.registration_opens_at)?'not_open':t<Date.parse(input.registration_closes_at)?'open':'closed',
    schedule_revision:rev.revision,revision_state:rev.revision_state as View['revision_state'],
    state_evaluated_at:now.toISOString(),is_ongoing:row.status==='published' && live.some(s=>Date.parse(s.starts_at)<=t && t<Date.parse(s.ends_at)),
    ...(management && {has_pending_review:row.reviews.some(r=>r.status==='pending'),current_review_id:row.reviews.find(r=>r.status==='pending')?.id}),
    ...(row.published_revision!==null && {published_revision:row.published_revision})};
  if(!management) delete item.group_join_instructions;
  return item;
}

type Query = Record<string,string>;
export function paginate<T>(items:T[],query:Query) {
  const page=Number(query.page ?? 1), page_size=Number(query.page_size ?? 20);
  if(!Number.isSafeInteger(page)||page<1) invalid('page','页码必须为正整数');
  if(!Number.isInteger(page_size)||page_size<1||page_size>100) invalid('page_size','每页显示 1 至 100 条');
  return {items:items.slice((page-1)*page_size,page*page_size),total:items.length,page,page_size};
}
export function filterViews(items:View[],query:Query) {
  const from=Date.parse(query.from),to=Date.parse(query.to);
  if((query.from!==undefined||query.to!==undefined) && !(Number.isFinite(from)&&Number.isFinite(to)&&from<to&&to-from<=31*86400000))
    invalid('from','日期窗口须成对填写，最长 31 天');
  if(query.is_ongoing && !['true','false'].includes(query.is_ongoing)) invalid('is_ongoing','进行中筛选值无效');
  return items.filter(a=>(!query.q || [a.title,a.activity_code].some(v=>v.includes(query.q))) &&
    (!query.campus||a.campus===query.campus) && (!query.status||a.status===query.status) &&
    (!query.owner_account_id||a.owner_account_id===query.owner_account_id) &&
    (!query.registration_phase||a.registration_phase===query.registration_phase) &&
    (!query.is_ongoing||a.is_ongoing===(query.is_ongoing==='true')) &&
    (!query.from||slots(a.schedule).some(s=>Date.parse(s.starts_at)<to&&Date.parse(s.ends_at)>from)));
}
