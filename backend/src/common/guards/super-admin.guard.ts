import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminUser } from '../decorators/current-admin.decorator';
import { isSuperAdmin } from '../auth/permission-check.util';

/**
 * Restricts a route to SUPER_ADMIN. Must run AFTER AdminGuard: it reads the role
 * AdminJwtStrategy resolved from the database, never a token or body claim.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AdminUser }>().user;
    if (!user || !isSuperAdmin(user)) throw new ForbiddenException('Only a Super Admin can perform this action');
    return true;
  }
}
