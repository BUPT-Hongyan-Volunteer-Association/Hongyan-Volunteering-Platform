import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { parse } from 'yaml';
import type { ActivityInput, ActivityPublicationContent } from '@hongyan/contracts/types';
import { BusinessError, invalid } from '../http.js';
import { campuses, campusName } from '@hongyan/contracts/activity';
import { validateSchedule } from './schedule.js';

const source = parse(
  readFileSync(
    new URL('../../../../packages/contracts/openapi_v1.2.5.yaml', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
formats.default(ajv);
ajv.addSchema({ $id: 'hongyan', components: source.components });
function issues(name: string, body: unknown) {
  const check = ajv.getSchema('hongyan#/components/schemas/' + name)!;
  if (!check(body)) {
    return (check.errors ?? []).map((e) => ({
      field: [
        ...e.instancePath.split('/').filter(Boolean),
        e.params.missingProperty ?? e.params.additionalProperty,
      ]
        .filter(Boolean)
        .join('.'),
      code: 'validation_error',
      message: e.keyword === 'required' ? '缺少必填项' : '字段值或组合不符合要求',
    }));
  }
  return [];
}
export function validate<T>(name: string, body: unknown): T {
  const problems = issues(name, body);
  if (problems.length) throw new BusinessError(422, 'validation_error', '请检查输入字段', problems);
  return body as T;
}
export function content(value: unknown, publication: true): ActivityPublicationContent;
export function content(value: unknown): ActivityInput;
export function content(value: unknown, publication = false) {
  const a = validate<ActivityInput>('activity_input', value);
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
    const hasContact =
      a.contacts !== undefined
        ? a.contacts.length > 0
        : !!(a.phone || a.wechat || (!dateOnly && a.contact_text?.trim()));
    if (!hasContact) need('contacts', '请至少填写一项联系方式');
    if (!a.result_expected_date && !a.result_expected_at)
      need('result_expected_date', '请选择预计结果公布日期');
    if (!a.group_join_instructions?.trim() && !a.group_qr_id)
      need('group_join_instructions', '请填写入群方式或上传群二维码');
    if (!a.hours_import_date && (dateOnly || !a.hours_import_expected_at))
      need('hours_import_date', '请选择预计时长导入日期');
    if (!!a.expected_hours !== !!a.expected_hours_basis)
      need(
        a.expected_hours ? 'expected_hours_basis' : 'expected_hours',
        '预计时长和口径须成对填写',
      );
    if (dateOnly && a.campus && !campuses.includes(campusName(a.campus)))
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
