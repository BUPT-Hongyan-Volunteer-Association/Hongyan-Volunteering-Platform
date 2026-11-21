import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export class BusinessError extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    details?: { field: string; row?: number; code: string; message: string }[],
    context?: object,
  ) {
    super({ code, message, ...(details && { details }), ...(context && { context }) }, status);
  }
}
export function invalid(field: string, message: string): never {
  throw new BusinessError(422, 'validation_error', message, [
    { field, code: 'validation_error', message },
  ]);
}
export function envelope<T>(data: T) {
  return { data, request_id: randomUUID() };
}
export function denied(): never {
  throw new BusinessError(403, 'forbidden', '当前身份无权执行此操作');
}
export function invisible(): never {
  throw new BusinessError(404, 'not_found', '记录不存在或不可见');
}
export function expired(): never {
  throw new BusinessError(401, 'unauthorized', '请重新登录');
}
