import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { StringValue } from 'ms';
import { PrismaService } from '../../database/prisma.service';
import { ALL_PERMISSION_NAMES, SUPER_ADMIN_ROLE } from '../../../prisma/bootstrap/permission-catalogue';
import { AdminLoginLimiter } from './admin-login-limiter';
import { ADMIN_ACCESS_TOKEN_TYPE, loadAdminSessionConfig } from './admin-session.config';
import { AdminSessionStore } from './admin-session.store';

/**
 * bcrypt (cost 12, the same cost real admin hashes use) of a random value that was
 * discarded when this constant was generated. Comparing against it when the email is
 * unknown or the account is inactive makes those paths do the same hashing work as a
 * wrong password, so response timing no longer reveals which emails are admins (H5).
 */
const DUMMY_PASSWORD_HASH = '$2b$12$GLuJqH8iNX0A5ULFwFawe.GP573KM/iApl3AruXd5gJEwrczek8qK';

export interface AdminLoginResult {
  /** Delivered ONLY as the httpOnly cookie by the controller - never in a response body. */
  accessToken: string;
  expiresAt: string;
  user: { id: string; name: string; email: string; role: { id: string; name: string } | null };
  permissions: string[];
}

export class LoginRateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many sign-in attempts. Please wait and try again.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly session = loadAdminSessionConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: AdminSessionStore,
    private readonly limiter: AdminLoginLimiter,
  ) {}

  async login(rawEmail: string, password: string, clientIp = 'unknown'): Promise<AdminLoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const emailRef = createHash('sha256').update(email).digest('hex').slice(0, 12);

    const decision = await this.limiter.check(email, clientIp);
    if (!decision.allowed) {
      this.logger.warn({ event: 'admin.login.rate_limited', emailRef, ip: clientIp, retryAfterSeconds: decision.retryAfterSeconds });
      throw new LoginRateLimitedException(decision.retryAfterSeconds);
    }

    const admin = await this.prisma.admin.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });

    // Always exactly one bcrypt comparison, whichever branch fails.
    const hash = admin?.isActive ? admin.passwordHash : DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!admin || !admin.isActive || !passwordMatches) {
      await this.limiter.recordFailure(email, clientIp);
      const reason = !admin ? 'unknown_email' : !admin.isActive ? 'inactive' : 'bad_password';
      this.logger.warn({ event: 'admin.login.failed', reason, emailRef, ip: clientIp });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.limiter.reset(email, clientIp);

    const roleNames = admin.roles.map((r) => r.role.name);
    const primary = admin.roles.find((r) => r.role.name === SUPER_ADMIN_ROLE) ?? admin.roles[0];
    const permissions = await this.getAdminPermissions(admin.id, roleNames);

    const sid = await this.sessions.create(admin.id, this.session.ttlMs);
    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, sid, typ: ADMIN_ACCESS_TOKEN_TYPE },
      { expiresIn: this.session.ttl as StringValue },
    );
    this.logger.log({ event: 'admin.login.succeeded', adminId: admin.id });

    return {
      accessToken,
      expiresAt: new Date(Date.now() + this.session.ttlMs).toISOString(),
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: primary ? { id: primary.role.id, name: primary.role.name } : null,
      },
      permissions,
    };
  }

  /** Revokes the server-side session. Idempotent. */
  async logout(sid: string | undefined): Promise<void> {
    if (sid) await this.sessions.revoke(sid);
  }

  /** Flat permission list for the UI. SUPER_ADMIN holds the whole canonical catalogue. */
  async getAdminPermissions(adminId: string, roleNames: string[]): Promise<string[]> {
    if (roleNames.includes(SUPER_ADMIN_ROLE)) return [...ALL_PERMISSION_NAMES];
    const grants = await this.prisma.rolePermission.findMany({
      where: { role: { admins: { some: { adminId } } } },
      include: { permission: true },
    });
    return [...new Set(grants.map((g) => `${g.permission.subject}.${g.permission.action}`))];
  }
}
