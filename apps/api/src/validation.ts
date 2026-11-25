import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { parse } from 'yaml';
import { BusinessError } from './http.js';

const source = parse(
  readFileSync(
    new URL('../../../packages/contracts/openapi_v1.2.5.yaml', import.meta.url),
    'utf8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
formats.default(ajv);
ajv.addSchema({ $id: 'hongyan', components: source.components });
export function issues(name: string, body: unknown) {
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
