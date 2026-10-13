import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AdminAuthService, LoginRateLimitedException } from '../admin-auth.service';
import { AdminLoginDto } from '../application/dto/admin-auth.dto';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { CurrentAdmin, AdminUser } from '../../../common/decorators/current-admin.decorator';
import {
  adminCookieExtractor,
  clearAdminAuthCookies,
  clearAdminSessionMarker,
  setAdminAuthCookies,
  setAdminSessionMarker,
} from '../../../common/auth/auth-cookies.util';
import { ADMIN_ACCESS_TOKEN_TYPE } from '../admin-session.config';
import type { AdminJwtPayload } from '../infrastructure/admin-jwt.strategy';

/** Per-IP ceiling on login attempts (H5); the per-account backoff lives in AdminLoginLimiter. */
export const ADMIN_LOGIN_THROTTLE = { limit: 5, ttl: 60_000 } as const;

@ApiTags('admin-auth')
@Controller({ path: 'admin/auth', version: '1' })
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * H4: the access token is delivered ONLY as the httpOnly ms_admin_access cookie.
   * It is not in the response body, so no page script can read or persist it.
   */
  @Post('login')
  @Throttle({ default: ADMIN_LOGIN_THROTTLE })
  async login(@Body() dto: AdminLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let result;
    try {
      result = await this.auth.login(dto.email, dto.password, req.ip ?? 'unknown');
    } catch (err) {
      if (err instanceof LoginRateLimitedException) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      throw err;
    }
    setAdminAuthCookies(res, { accessToken: result.accessToken });
    setAdminSessionMarker(res); // JS-readable presence marker (no token)
    return { user: result.user, permissions: result.permissions, expiresAt: result.expiresAt };
  }

  @UseGuards(AdminGuard)
  @Get('me')
  me(@CurrentAdmin() admin: AdminUser) {
    return {
      id: admin.sub,
      email: admin.email,
      name: admin.name,
      isActive: admin.isActive,
      role: admin.role ?? null,
      permissions: admin.permissions,
    };
  }

  /**
   * Revokes the server-side session and clears the cookies. Deliberately not behind
   * AdminGuard: an already-expired session must still be able to clear its cookies.
   * Revocation happens only when the presented token is a genuine admin access token
   * (signature verified; expiry ignored because an expired session is already dead).
   * Cookie-authenticated, so the global CSRF guard applies.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const header = req.headers.authorization;
    const token = adminCookieExtractor(req) ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, { ignoreExpiration: true });
        if (payload.typ === ADMIN_ACCESS_TOKEN_TYPE) await this.auth.logout(payload.sid);
      } catch {
        // forged / foreign token: nothing to revoke, cookies are still cleared
      }
    }
    clearAdminAuthCookies(res);
    clearAdminSessionMarker(res);
    return { success: true };
  }
}
