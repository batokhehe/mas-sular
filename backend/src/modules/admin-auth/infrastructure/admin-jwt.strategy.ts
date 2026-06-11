import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../database/prisma.service';

interface AdminJwtPayload {
  sub: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions?: string[];
}

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.adminAccessSecret') ?? 'development-only-admin-secret',
    });
  }

  async validate(payload: AdminJwtPayload) {
    const admin = await this.prisma.admin.findFirst({
      where: { id: payload.sub, isActive: true },
      select: { id: true },
    });
    if (!admin) {
      throw new UnauthorizedException('Admin account is no longer active');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      isActive: payload.isActive,
      role: payload.role ?? null,
      permissions: payload.permissions ?? [],
    };
  }
}
