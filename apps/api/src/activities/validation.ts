import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { parse } from 'yaml';
import type { ActivityInput } from '@hongyan/contracts/types';
import { BusinessError, invalid } from '../http.js';
import { slots } from './read.js';

const source = parse(
  readFileSync(
    new URL('../../../../packages/contracts/openapi_v1.2.4.yaml', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
formats.default(ajv);
ajv.addSchema({ $id: 'hongyan', components: source.components });
export function validate<T>(name: string, body: unknown): T {
  const check = ajv.getSchema('hongyan#/components/schemas/' + name)!;
  if (!check(body)) {
    const problems = (check.errors ?? []).map((e) => ({
      field: [
        ...e.instancePath.split('/').filter(Boolean),
        e.params.missingProperty ?? e.params.additionalProperty,
      ]
        .filter(Boolean)
        .join('.'),
      code: 'validation_error',
      message: e.keyword === 'required' ? '缺少必填项' : '字段值或组合不符合要求',
    }));
    throw new BusinessError(422, 'validation_error', '请检查输入字段', problems);
  }
  return body as T;
}
export function content(value: unknown, publication = false) {
  const a = validate<ActivityInput>(
    publication ? 'activity_publication_content' : 'activity_input',
    value,
  );
  const segments = slots(a.schedule).sort(
    (x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at),
  );
  if (!segments.length) invalid('schedule', '至少需要一个有效时段');
  let previous = -Infinity;
  for (const s of segments) {
    const start = Date.parse(s.starts_at),
      end = Date.parse(s.ends_at);
    if (!(start < end && previous <= start)) invalid('schedule', '时段必须有效且互不重叠');
    previous = end;
  }
  if (
    !(
      Date.parse(a.registration_opens_at) < Date.parse(a.registration_closes_at) &&
      Date.parse(a.registration_closes_at) <= Date.parse(segments[0].starts_at)
    )
  )
    invalid('registration_closes_at', '开放须早于截止，截止不能晚于首段开始');
  return a;
}
