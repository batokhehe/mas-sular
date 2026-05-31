import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

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
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.adminAccessSecret') ?? 'development-only-admin-secret',
    });
  }

  validate(payload: AdminJwtPayload) {
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
