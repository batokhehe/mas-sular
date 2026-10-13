/**
 * Reverse-proxy trust (production-readiness B3).
 *
 * Behind a reverse proxy every TCP connection comes from the proxy, so without a
 * trust setting Express reports the PROXY's address as `req.ip` — and the global
 * ThrottlerGuard (keyed on `req.ip`) put every visitor into one shared 120/min
 * bucket. Measured against the production image: 125 requests carrying 125
 * different X-Forwarded-For client addresses were throttled as one client.
 *
 * The value is a HOP COUNT, never `true`: with N trusted hops Express takes the
 * client address N entries from the RIGHT of X-Forwarded-For — the entry our own
 * proxy appended — and ignores everything to its left, which is whatever the
 * client chose to send. Trusting all hops (`true`) would hand the rate-limit key
 * to the client.
 *
 * Hostinger topology: Internet -> ONE reverse proxy (Caddy/Nginx) -> backend.
 * The backend publishes no host port (docker-compose.production.yml), so the
 * proxy is the only peer that can reach it: TRUST_PROXY_HOPS=1. Add a hop only
 * if another proxy/CDN that APPENDS to X-Forwarded-For is placed in front.
 *
 * Local development publishes :3001 directly to the browser with no proxy, so the
 * default there is 0 (trust nothing) — identical to the behavior before B3.
 */
export const TRUST_PROXY_MAX_HOPS = 3;

/** Minimal surface of the Express application this needs (keeps tests framework-free). */
export interface TrustProxyTarget {
  set(setting: 'trust proxy', value: number): unknown;
}

/** The hop count to trust. Explicit TRUST_PROXY_HOPS wins; unset means 0 (trust nothing). */
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > TRUST_PROXY_MAX_HOPS) {
    // env.validation rejects this at boot; refusing here too keeps a misconfigured
    // value from silently widening trust if this is ever called without validation.
    throw new Error(`TRUST_PROXY_HOPS must be an integer between 0 and ${TRUST_PROXY_MAX_HOPS}`);
  }
  return hops;
}

/** Apply the trust setting to the Express instance. Returns the hop count applied. */
export function configureTrustProxy(app: TrustProxyTarget, env: NodeJS.ProcessEnv = process.env): number {
  const hops = resolveTrustProxyHops(env);
  app.set('trust proxy', hops);
  return hops;
}
