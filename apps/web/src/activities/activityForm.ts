import type { ActivityInputWritable as ActivityInput, ActivityRevision } from '@hongyan/contracts';
import { beijingInput, beijingISO } from '@hongyan/ui/activityDisplay';
import { activityFields as fields } from '@hongyan/ui/activityFields';

import { serviceDates } from '@hongyan/contracts/activity';

export function formValues(item?: ActivityRevision['content']) {
  const values: Record<string, unknown> = { waitlist_capacity: 0, ...item, ...serviceDates(item?.schedule) };
  return Object.fromEntries(
    fields
      .filter(([key]) => key !== 'contacts')
      .map(([key, , type]) => {
        const v = values[key];
        return [
          key,
          type === 'datetime-local' && v
            ? beijingInput(v)
            : String(v ?? ''),
        ];
      }),
  );
}
export function buildPatch(
  v: Record<string, string>, base: Record<string, string>, saved: ActivityRevision['content'] | undefined,
  source: ActivityRevision['content'] | undefined, contacts: string[] | undefined, partial: boolean,
) {
  const result: Record<string, unknown> = {};
  if (contacts) result.contacts = contacts;
  for (const [key, , type] of fields) {
    if (key === 'contacts' || key.startsWith('duration_')) continue;
    const value = String(v[key] ?? '').trim();
    if ((partial && v[key] === base[key]) || (!partial && !value)) continue;
    if (key === 'group_qr_id' && value.startsWith('data:')) result.group_qr_upload = value;
    else if (!value) result[key] = null;
    else if (type === 'datetime-local') result[key] = beijingISO(value);
    else result[key] = type === 'number' ? Number(value) : value;
  }
  const start = v.duration_start_date,
    end = v.duration_end_date;
  const original = source && formValues(source);
  const datesChanged =
    start !== base.duration_start_date || end !== base.duration_end_date;
  if (
    source?.schedule &&
    original &&
    start === original.duration_start_date &&
    end === original.duration_end_date
  )
    result.schedule = source.schedule;
  else if (datesChanged) {
    const schedule = source?.schedule ?? saved?.schedule;
    result.schedule = {
      ...(schedule?.schedule_type === 'weekly' || schedule?.schedule_type === 'custom' ? schedule : { schedule_type: 'date_range' }),
      duration_start_date: start || undefined,
      duration_end_date: end || undefined,
    };
  }
  if (source && original) {
    for (const k of ['registration_opens_at', 'registration_closes_at'] as const)
      if (v[k] === original[k] && source[k] !== saved?.[k]) result[k] = source[k] ?? null;
  }
  const converting =
    saved?.schedule?.schedule_type === 'continuous' &&
    (result.schedule as ActivityInput['schedule'])?.schedule_type === 'date_range';
  if (converting) {
    for (const key of ['registration_opens_at', 'registration_closes_at'] as const)
      if (v[key]) result[key] = beijingISO(v[key]);
    if (v.hours_import_date) result.hours_import_date = v.hours_import_date;
  }
  return result;
}

export function recruitmentValues(input?: ActivityRevision['content']) {
  return {
    registration_mode: input?.registration_mode ?? 'whole' as const,
    allow_multiple_roles: input?.allow_multiple_roles ?? false,
    allow_multiple_slots: input?.allow_multiple_slots ?? false,
    registration_items: (input?.registration_items ?? []).map(item => {
      const start = item.starts_at ? beijingInput(item.starts_at) : '';
      const end = item.ends_at ? beijingInput(item.ends_at) : '';
      const allDay = start.endsWith('T00:00') && Date.parse(item.starts_at!) % 60000 === 0 && end.endsWith('T00:00') &&
        Date.parse(item.ends_at!) - Date.parse(item.starts_at!) === 86400000;
      return { id: item.id, role: item.role ?? '', allDay, start, end, originalStart: item.starts_at, originalEnd: item.ends_at,
        capacity: item.capacity, waitlist_capacity: item.waitlist_capacity };
    }),
    questions: (input?.questions ?? []).map(q => ({
      ...q, description: q.description ?? '', options: (q.options ?? []).map(o => ({ ...o })),
    })),
  };
}

export type RecruitmentForm = ReturnType<typeof recruitmentValues>;

export type RecruitmentField = keyof RecruitmentForm;
const recruitmentFields: RecruitmentField[] = ['registration_mode', 'allow_multiple_roles', 'allow_multiple_slots', 'registration_items', 'questions'];
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function changedRecruitmentFields(base: RecruitmentForm, local: RecruitmentForm) {
  return recruitmentFields.filter(key => !equal(base[key], local[key]));
}

export function copyRecruitmentField<K extends RecruitmentField>(target: RecruitmentForm, source: RecruitmentForm, key: K) {
  target[key] = source[key];
}

export function rebaseRecruitment(base: RecruitmentForm, local: RecruitmentForm, remote: RecruitmentForm) {
  const changedLocal = changedRecruitmentFields(base, local);
  const changedRemote = changedRecruitmentFields(base, remote);
  const merged = { ...remote };
  const conflicts: RecruitmentField[] = [];
  for (const field of changedLocal) {
    if (equal(local[field], remote[field])) continue;
    copyRecruitmentField(merged, local, field);
    if (changedRemote.includes(field)) conflicts.push(field);
  }
  // A mode switch discards settings that only exist for batch signup.
  if (local.registration_mode !== remote.registration_mode &&
    (changedLocal.includes('registration_mode') && changedRemote.some(k => k !== 'questions') ||
     changedRemote.includes('registration_mode') && changedLocal.some(k => k !== 'questions'))) {
    for (const field of recruitmentFields.filter(k => k !== 'questions')) copyRecruitmentField(merged, local, field);
    return { merged, conflicts: ['registration_mode', ...conflicts.filter(k => k === 'questions')] as RecruitmentField[] };
  }
  return { merged, conflicts };
}

function preciseTime(local: string, original?: string) {
  if (!local) return undefined;
  return original && beijingInput(original) === local ? original : beijingISO(local);
}

export function recruitmentPatch(config: RecruitmentForm) {
  return {
    registration_mode: config.registration_mode,
    allow_multiple_roles: config.allow_multiple_roles,
    allow_multiple_slots: config.allow_multiple_slots,
    registration_items: config.registration_mode === 'whole' ? [] : config.registration_items.map(item => {
      const starts_at = item.allDay && item.start ? beijingISO(item.start.slice(0,10) + 'T00:00') : preciseTime(item.start, item.originalStart);
      const ends_at = item.allDay
        ? starts_at && new Date(Date.parse(starts_at) + 86400000).toISOString()
        : preciseTime(item.end, item.originalEnd);
      return { id: item.id, role: item.role.trim() || undefined, starts_at, ends_at,
        capacity: Number(item.capacity), waitlist_capacity: Number(item.waitlist_capacity) };
    }),
    questions: config.questions.map(q => ({ ...q, title: q.title.trim(), description: q.description.trim() || undefined,
      options: q.type === 'text' ? undefined : q.options.map(o => ({ ...o, label: o.label.trim() })) })),
  };
}
