import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { hasAllPermissions } from '../../../common/auth/permission-check.util';
import { PaymentsService } from '../payments.service';

/**
 * H3: every check that decides whether an upload may be STORED runs in a guard.
 * Nest runs guards before interceptors, so these complete before the Multer
 * FileInterceptor reads a single byte of the body - an unauthorised request can
 * never cause a file to be written.
 */

/** Anonymous receipt upload: the single-use upload token must be active and the payment uploadable. */
@Injectable()
export class PaymentUploadTokenGuard implements CanActivate {
  constructor(private readonly payments: PaymentsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    await this.payments.getUploadPage(String(req.params.token ?? '')); // throws 404 when invalid/used/expired
    return true;
  }
}

/** Logged-in receipt upload: the payment must belong to the authenticated customer (after JwtAuthGuard). */
@Injectable()
export class PaymentOwnerGuard implements CanActivate {
  constructor(private readonly payments: PaymentsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: { sub?: string } }>();
    if (!req.user?.sub) throw new NotFoundException('Payment not found');
    await this.payments.assertPaymentOwner(String(req.params.paymentId ?? ''), req.user.sub);
    return true;
  }
}

/**
 * Receipt download (L8): an admin session (cookie/Bearer, admin-jwt) OR a customer
 * session (jwt). Passport tries the strategies in order; the first that
 * authenticates wins. What that principal may read is decided in the handler.
 */
@Injectable()
export class AdminOrCustomerGuard extends AuthGuard(['admin-jwt', 'jwt']) {}

export interface ReceiptPrincipal {
  kind?: 'admin';
  sub: string;
  role?: string | null;
  permissions?: string[];
}

/** Admins need Payment.read; everyone else is a customer and must own the payment. */
export function isAdminWithPaymentRead(user: ReceiptPrincipal): boolean {
  return user.kind === 'admin' && hasAllPermissions(user, ['Payment.read']);
}
