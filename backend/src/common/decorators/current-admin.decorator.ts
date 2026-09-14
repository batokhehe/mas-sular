import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AdminUser {
  sub: string;
  /** Server-side session id (H4); present on every request authenticated by AdminJwtStrategy. */
  sid?: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions: string[];
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AdminUser }>();
    return request.user;
  },
);
