import type { ActivityInputWritable as ActivityInput, ActivityRevision } from '@hongyan/contracts';
import { beijingInput, beijingISO, localDate } from '@hongyan/ui/activityDisplay';
import { activityFields as fields } from '@hongyan/ui/activityFields';

export function formValues(item?: ActivityRevision['content']) {
  const schedule = item?.schedule;
  const dates =
    schedule?.schedule_type === 'continuous'
      ? {
          duration_start_date: localDate(schedule.starts_at),
          duration_end_date: localDate(schedule.ends_at),
        }
      : schedule;
  const values: Record<string, unknown> = {
    ...item,
    ...dates,
  };
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
  else if (datesChanged)
    result.schedule = {
      schedule_type: 'date_range',
      ...(start && { duration_start_date: start }),
      ...(end && { duration_end_date: end }),
    };
  if (source && original) {
    for (const k of ['registration_opens_at', 'registration_closes_at'] as const)
      if (v[k] === original[k] && source[k] !== saved?.[k]) result[k] = source[k] ?? null;
    if (saved?.selection_text !== source.selection_text) result.selection_text = source.selection_text ?? null;
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
