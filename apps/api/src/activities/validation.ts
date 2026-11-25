import type { ActivityInput, ActivityPublicationContent } from '@hongyan/contracts/types';
import { campuses, campusName } from '@hongyan/contracts/activity';
import { BusinessError, invalid } from '../http.js';
import { issues, validate } from '../validation.js';
import { validateSchedule } from './schedule.js';

export function content(value: unknown, publication: true): ActivityPublicationContent;
export function content(value: unknown): ActivityInput;
export function content(value: unknown, publication = false) {
  const a = validate<ActivityInput>('activity_input', value);
  if (a.campus) a.campus = campusName(a.campus);
  if (!a.title.trim()) invalid('title', '请填写活动标题');
  const problems = publication ? issues('activity_publication_content', a) : [];
  const need = (field: string, message: string) =>
    problems.push({ field, code: 'validation_error', message });
  const schedule = a.schedule;
  const dateOnly = schedule?.schedule_type === 'date_range';
  if (dateOnly) {
    for (const key of ['registration_opens_at', 'registration_closes_at'] as const) {
      if (a[key] && Date.parse(a[key]) % 60000 !== 0) need(key, '请选择精确到分钟的时间');
    }
  }
  if (publication) {
    if (!schedule || dateOnly) {
      if (!schedule?.duration_start_date) need('duration_start_date', '请选择活动开始日期');
      if (!schedule?.duration_end_date) need('duration_end_date', '请选择活动结束日期');
    }
    if (!a.contacts?.length) need('contacts', '请至少填写一项联系方式');
    if (!a.result_expected_date)
      need('result_expected_date', '请选择预计结果公布日期');
    if (!a.group_join_instructions?.trim() && !a.group_qr_id)
      need('group_join_instructions', '请填写入群方式或上传群二维码');
    if (!a.hours_import_date)
      need('hours_import_date', '请选择预计时长导入日期');
    if (!!a.expected_hours !== !!a.expected_hours_basis)
      need(
        a.expected_hours ? 'expected_hours_basis' : 'expected_hours',
        '预计时长和口径须成对填写',
      );
    if (dateOnly && a.campus && !campuses.includes(a.campus))
      need('campus', '请选择活动校区');
  }
  if (problems.length)
    throw new BusinessError(422, 'validation_error', '请补齐或修正以下字段', problems);
  const complete =
    schedule && (!dateOnly || (schedule.duration_start_date && schedule.duration_end_date));
  const firstStart = complete ? validateSchedule(schedule) : undefined;
  if (
    a.registration_opens_at &&
    a.registration_closes_at &&
    Date.parse(a.registration_opens_at) >= Date.parse(a.registration_closes_at)
  )
    invalid('registration_closes_at', '报名截止须晚于开放时间');
  if (
    !dateOnly &&
    firstStart !== undefined &&
    a.registration_closes_at &&
    Date.parse(a.registration_closes_at) > firstStart
  )
    invalid('registration_closes_at', '截止不能晚于首段开始');
  return a;
}
