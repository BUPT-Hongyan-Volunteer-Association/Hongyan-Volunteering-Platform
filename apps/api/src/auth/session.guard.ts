import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '../generated/prisma/client.js';
import { Database } from '../database.js';
import { BusinessError, expired } from '../http.js';
import { cookieHash } from './session.service.js';

export const SessionAccess = (mode: 'anonymous' | 'limited' | 'login') => SetMetadata('session_access', mode);
export interface Actor {
  account_id: string; username: string; display_name: string; roles: Role[]; must_change_password: boolean;
  student?: { id: string; account_id: string; name: string; student_no: string; version: number; status: 'active' };
}
export interface SessionRequest extends Request { actor: Actor; sessionHash: string }

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private db: Database, private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const mode = this.reflector.get<string>('session_access', ctx.getHandler());
    if (mode === 'anonymous') return true;
    const req = ctx.switchToHttp().getRequest<SessionRequest>();
    const now = new Date();
    req.sessionHash = cookieHash(req.headers.cookie);
    const session = await this.db.httpSession.findUnique({
      where: { id_hash: req.sessionHash, expires_at: { gt: now } },
      include: { account: { select: {
        id: true, active: true, username: true, display_name: true, must_change_password: true, student: true,
        roles: { where: { OR: [{ expires_at: null }, { expires_at: { gt: now } }] }, select: { role: true } },
      } } },
    });
    if (!session) expired();
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && session.csrf_token !== req.get('X-CSRF-Token'))
      throw new BusinessError(403, 'forbidden', '会话校验失败，请刷新页面');
    if (mode === 'login') return true;
    const a = session.account;
    if (!a?.active) expired();
    if (a.must_change_password && mode !== 'limited')
      throw new BusinessError(403, 'password_change_required', '首次登录请先修改密码');
    req.actor = { account_id: a.id, username: a.username, display_name: a.display_name, roles: a.roles.map(g => g.role),
      must_change_password: a.must_change_password, ...(a.student && {student: {...a.student, name:a.display_name, status:'active' as const}}) };
    return true;
  }
}
