import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * /metrics is internal-only (M1). Two ways in:
 *
 *   1. A DIRECT in-network scrape (Prometheus on the Docker network -> backend:3001).
 *      Such a request carries no X-Forwarded-For / X-Real-IP. The production reverse
 *      proxy always sets both, and a client cannot remove a header nginx adds, so any
 *      request that came through the public edge is recognisable - and refused.
 *   2. Optionally, METRICS_TOKEN: when set, a scraper may present it as a Bearer token
 *      (e.g. a remote Prometheus going through the proxy).
 *
 * Refusal is a 404 so the endpoint's existence is not advertised. nginx also denies
 * /metrics on the public API host; this guard is the application-level backstop.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = process.env.METRICS_TOKEN?.trim();
    const header = req.headers.authorization;
    if (token && header?.startsWith('Bearer ')) {
      const a = Buffer.from(header.slice(7));
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    const proxied = req.headers['x-forwarded-for'] !== undefined || req.headers['x-real-ip'] !== undefined;
    if (!proxied) return true;
    throw new NotFoundException();
  }
}
