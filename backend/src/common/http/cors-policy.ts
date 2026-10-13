import type { NextFunction, Request, Response } from 'express';

/**
 * Cross-origin policy (L5).
 *
 * Before: the `cors` origin callback answered a disallowed origin with an Error,
 * which Express turned into an HTTP 500 - noise in the logs and incident center,
 * and a misleading "server error" for what is a policy decision.
 *
 * Now a dedicated middleware, registered BEFORE the cors middleware, answers a
 * disallowed Origin with a clean 403 and no internal detail. Requests without an
 * Origin header (same-origin navigations, curl, server-to-server webhooks) are not
 * affected, and allowed origins continue to the cors middleware unchanged.
 */

export function parseAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  // The API's own origin (APP_URL) is always allowed: pages it serves may call it.
  if (env.APP_URL) {
    try {
      origins.push(new URL(env.APP_URL).origin);
    } catch {
      // APP_URL is URL-validated at boot; ignore here
    }
  }
  return [...new Set(origins)];
}

export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return !origin || allowed.includes(origin);
}

export function originRejectionMiddleware(allowed: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowed)) {
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, message: 'Origin not allowed' });
  };
}

/** Options for app.enableCors(): an exact allowlist, credentials on, never reflect-all. */
export function corsOptions(allowed: readonly string[]) {
  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, isOriginAllowed(origin, allowed));
    },
    credentials: true,
  };
}
