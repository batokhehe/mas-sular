import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Prisma } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';
import { adminCookieExtractor } from '../../../common/auth/auth-cookies.util';
import { ALL_PERMISSION_NAMES, SUPER_ADMIN_ROLE } from '../../../../prisma/bootstrap/permission-catalogue';
import { ADMIN_ACCESS_TOKEN_TYPE } from '../admin-session.config';
import { AdminSessionStore } from '../admin-session.store';

export interface AdminJwtPayload {
  sub?: string;
  sid?: string;
  typ?: string;
}

/** One row per granted permission; a single all-NULL-permission row when the admin has no grant. */
interface AdminAuthRow {
  id: string;
  email: string;
  name: string;
  roleName: string | null;
  subject: string | null;
  action: string | null;
}

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: AdminSessionStore,
  ) {
    const secret = config.get<string>('jwt.adminAccessSecret');
    if (!secret) {
      throw new Error('JWT_ADMIN_ACCESS_SECRET is not configured'); // no insecure fallback
    }
    super({
      // The httpOnly ms_admin_access cookie is the admin UI's credential (H4); the
      // Bearer header stays accepted for operator tooling. Neither is ever read from
      // the URL (H2) - there is no query-string extractor.
      jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), adminCookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
    });
  }

  /**
   * Accepts a token only when ALL of these hold (H4):
   *   1. it is an admin ACCESS token (`typ`). Refresh tokens and any other signed
   *      shape are rejected - the audit found the 7-day refresh token worked here;
   *   2. its server-side session (`sid`) is still active - logout revokes it;
   *   3. the admin exists and is active (C7a, unchanged).
   *
   * Role and permissions are then read from the DATABASE on every request (C7a):
   * the token carries no role or permission claim at all, so revocations apply
   * immediately. SUPER_ADMIN is recognised by the canonical system role only, and is
   * given the whole code catalogue for the UI (it bypasses checks regardless).
   *
   * ONE database round-trip; `payload.sub` is attacker-controlled and bound through
   * Prisma.sql, never interpolated.
   */
  async validate(payload: AdminJwtPayload) {
    if (payload?.typ !== ADMIN_ACCESS_TOKEN_TYPE || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new UnauthorizedException('Invalid admin session');
    }
    if (!(await this.sessions.isActive(payload.sid, payload.sub))) {
      throw new UnauthorizedException('Admin session has ended. Please sign in again.');
    }

    const rows = await this.prisma.$queryRaw<AdminAuthRow[]>(Prisma.sql`
      SELECT a.id            AS id,
             a.email         AS email,
             a.name          AS name,
             r.name          AS "roleName",
             p.subject       AS subject,
             p.action        AS action
      FROM "Admin" a
      LEFT JOIN "AdminRole" ar ON ar."adminId" = a.id
      LEFT JOIN "Role" r ON r.id = ar."roleId"
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r.id
      LEFT JOIN "Permission" p ON p.id = rp."permissionId"
      WHERE a.id = ${payload.sub} AND a."isActive" = true
    `);

    if (rows.length === 0) {
      throw new UnauthorizedException('Admin account is no longer active');
    }

    const roleNames = rows.map((row) => row.roleName).filter((name): name is string => !!name);
    const role = roleNames.find((name) => name === SUPER_ADMIN_ROLE) ?? roleNames[0] ?? null;

    const permissions = new Set<string>();
    if (role === SUPER_ADMIN_ROLE) {
      ALL_PERMISSION_NAMES.forEach((p) => permissions.add(p));
    } else {
      for (const row of rows) {
        if (row.subject && row.action) permissions.add(`${row.subject}.${row.action}`);
      }
    }

    return {
      kind: 'admin' as const,
      sub: rows[0].id,
      sid: payload.sid,
      email: rows[0].email,
      name: rows[0].name,
      isActive: true, // the query filtered on it
      role,
      permissions: Array.from(permissions),
    };
  }
}
