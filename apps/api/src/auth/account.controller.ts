import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { Database } from '../database.js';
import { BusinessError, envelope, expired, invalid } from '../http.js';
import { hashPassword, matches } from './password.js';
import { clearCookie, issueSession, setCookie } from './session.service.js';
import { SessionAccess, type SessionRequest } from './session.guard.js';

const dummyHash = hashPassword(randomBytes(32).toString('hex'));
const badCredentials = () => new BusinessError(401, 'invalid_credentials', '账号或密码不正确');

@Controller()
export class AccountController {
  constructor(private db: Database) {}

  @Post('auth/login')
  @HttpCode(200)
  @SessionAccess('login')
  async login(
    @Req() req: SessionRequest,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const username = body?.username,
      password = body?.password;
    if (typeof username !== 'string' || !username || username.length > 64)
      invalid('username', '请填写有效账号');
    if (typeof password !== 'string' || !password) invalid('password', '请输入密码');
    const key = createHash('sha256')
      .update(JSON.stringify([req.ip, username]))
      .digest('hex');
    const [bucket] = await this.db.$queryRaw<{ attempts: number }[]>`
      INSERT INTO login_window (key, attempts, expires_at) VALUES (${key}, 1, NOW()+interval '10 minutes')
      ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN login_window.expires_at<=NOW() THEN 1 ELSE login_window.attempts+1 END,
      expires_at=CASE WHEN login_window.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE login_window.expires_at END RETURNING attempts`;
    if (bucket.attempts > 8)
      throw new BusinessError(429, 'rate_limited', '尝试次数过多，请稍后再试');
    const account = await this.db.account.findUnique({ where: { username } });
    if (!(await matches(password, account?.password_hash ?? (await dummyHash))) || !account?.active || !account.password_hash)
      throw badCredentials();
    const issued = issueSession(account.id);
    const roles = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM account WHERE id=${account.id}::uuid FOR UPDATE`;
      const current = await tx.account.findUnique({
        where: { id: account.id, active: true, password_hash: account.password_hash },
      });
      if (!current) throw badCredentials();
      if (
        !(
          await tx.httpSession.deleteMany({
            where: { id_hash: req.sessionHash, expires_at: { gt: new Date() } },
          })
        ).count
      )
        expired();
      await tx.httpSession.create({ data: issued.data });
      await tx.loginWindow.deleteMany({
        where: { OR: [{ key }, { expires_at: { lte: new Date() } }] },
      });
      return tx.roleGrant.findMany({
        where: {
          account_id: account.id,
          OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
        },
      });
    });
    setCookie(res, issued);
    return envelope({
      account_id: account.id,
      roles: roles.map((r) => r.role),
      must_change_password: account.must_change_password,
      auth_state: account.must_change_password ? 'password_change_required' : 'authenticated',
    });
  }

  @Post('auth/change-password')
  @HttpCode(200)
  @SessionAccess('limited')
  async change(
    @Req() req: SessionRequest,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const next = body?.new_password;
    if (typeof next !== 'string' || !/^(?=.*[a-zA-Z])(?=.*[0-9]).{8,}$/u.test(next))
      invalid('new_password', '密码至少 8 个字符，并包含英文字母和数字');
    const id = req.actor.account_id;
    const account = await this.db.account.findUniqueOrThrow({ where: { id } });
    if (
      !account.password_hash || typeof body.current_password !== 'string' ||
      !(await matches(body.current_password, account.password_hash))
    )
      invalid('current_password', '当前密码不正确');
    if (account.must_change_password && next === body.current_password)
      invalid('new_password', '新密码须与初始或临时凭证不同');
    const password_hash = await hashPassword(next);
    const issued = issueSession(id);
    await this.db.$transaction(async (tx) => {
      const updated = await tx.account.updateMany({
        where: { id, active: true, password_hash: account.password_hash },
        data: { password_hash, must_change_password: false, version: { increment: 1 } },
      });
      if (
        !updated.count ||
        !(await tx.httpSession.findUnique({
          where: { id_hash: req.sessionHash, expires_at: { gt: new Date() } },
        }))
      )
        expired();
      await tx.httpSession.deleteMany({ where: { account_id: id } });
      await tx.httpSession.create({ data: issued.data });
    });
    setCookie(res, issued);
    res.set('Cache-Control', 'no-store').set('X-CSRF-Token', issued.data.csrf_token);
    return envelope({ completed: true });
  }

  @Post('auth/logout')
  @HttpCode(200)
  @SessionAccess('limited')
  async logout(@Req() req: SessionRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.httpSession.deleteMany({ where: { id_hash: req.sessionHash } });
    clearCookie(res);
    return envelope({ completed: true });
  }
  @Get('me') me(@Req() req: SessionRequest) {
    return envelope(req.actor);
  }
}
