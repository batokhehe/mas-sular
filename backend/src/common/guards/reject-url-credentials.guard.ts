import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/** Query keys that look like a credential. Their presence alone is refused. */
export const URL_CREDENTIAL_KEY = /^(token|access_?token|refresh_?token|id_?token|jwt|auth|authorization|bearer|session|sid)$/i;

/**
 * H2: credentials are never accepted in a URL. URLs are written to reverse-proxy
 * access logs, application request logs, browser history and Referer headers - the
 * audit found admin JWTs in both the nginx and the backend logs because the SSE
 * stream took `?token=`.
 *
 * Placed BEFORE the auth guards on routes that historically accepted such a
 * parameter, so a stale client fails loudly (401) instead of silently falling back
 * to cookie auth while still leaking its token into logs on every reconnect.
 */
@Injectable()
export class RejectUrlCredentialsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const offending = Object.keys(req.query ?? {}).some((key) => URL_CREDENTIAL_KEY.test(key));
    if (offending) {
      throw new UnauthorizedException('Credentials must not be sent in the URL. Use the session cookie.');
    }
    return true;
  }
}
