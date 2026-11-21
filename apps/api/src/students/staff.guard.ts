import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { staff } from '../activities/read.js';
import type { SessionRequest } from '../auth/session.guard.js';
import { denied } from '../http.js';

/**
 * 学生建档接口仅向老师审核员与技术服务管理员开放。
 * 作为控制器级守卫在拦截器之前执行，避免未授权用户触发文件上传解析。
 */
@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    if (!staff(request.actor)) denied();
    return true;
  }
}
