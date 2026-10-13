import { isIP } from 'net';

/** DI token for the JNE Webhook Status V2 configuration. */
export const JNE_WEBHOOK_CONFIG = 'JNE_WEBHOOK_CONFIG';

/**
 * The webhook source address(es) JNE confirmed in writing. Add an address here only
 * when JNE confirms it; never infer one.
 */
export const JNE_CONFIRMED_WEBHOOK_SOURCE_IPS: readonly string[] = ['110.239.85.204'];

export interface JneWebhookConfig {
  /**
   * JNE_WEBHOOK_ENABLED - only the exact string "true" opens the endpoint. It is
   * independent of JNE_ENABLED (booking/tracking credentials): receiving pushes needs
   * no JNE credential, and JNE's V2 documentation specifies no webhook
   * authentication, so the endpoint stays closed until an operator enables it.
   */
  enabled: boolean;
  /**
   * Client addresses (req.ip, which honours TRUST_PROXY_HOPS) allowed to call the
   * webhook. Always the JNE-confirmed address(es); outside JNE_ENVIRONMENT=production
   * an operator may add explicit extra addresses via JNE_WEBHOOK_EXTRA_SOURCE_IPS (for
   * example the public IP of whoever sends the agreed Postman test pushes). Absent
   * means "the confirmed JNE addresses only" - never "everyone".
   */
  allowedSourceIps?: readonly string[];
}

/** Canonical form for comparison: an IPv4-mapped IPv6 address becomes plain IPv4. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const ip = trimmed.toLowerCase().startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
  return isIP(ip) ? ip.toLowerCase() : null;
}

/** Parse a comma-separated IP list. Throws on any entry that is not an IP address. */
export function parseSourceIpList(raw: string | undefined, key = 'JNE_WEBHOOK_EXTRA_SOURCE_IPS'): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const ip = normalizeIp(part);
      if (!ip) throw new Error(`${key} must be a comma-separated list of IP addresses (got "${part}")`);
      return ip;
    });
}

/**
 * The problem with the extra-source-IP setting, or null when it is acceptable.
 * Production (JNE_ENVIRONMENT=production) may trust ONLY JNE-confirmed addresses.
 */
export function jneWebhookSourceIpIssue(env: NodeJS.ProcessEnv): string | null {
  let extra: string[];
  try {
    extra = parseSourceIpList(env.JNE_WEBHOOK_EXTRA_SOURCE_IPS);
  } catch (err) {
    return (err as Error).message;
  }
  if (env.JNE_ENVIRONMENT === 'production') {
    const unconfirmed = extra.filter((ip) => !JNE_CONFIRMED_WEBHOOK_SOURCE_IPS.includes(ip));
    if (unconfirmed.length) {
      return `JNE_WEBHOOK_EXTRA_SOURCE_IPS may not add addresses JNE has not confirmed when JNE_ENVIRONMENT=production (${unconfirmed.join(', ')})`;
    }
  }
  return null;
}

export function loadJneWebhookConfig(env: NodeJS.ProcessEnv = process.env): JneWebhookConfig {
  const issue = jneWebhookSourceIpIssue(env);
  if (issue) throw new Error(issue);
  const extra = parseSourceIpList(env.JNE_WEBHOOK_EXTRA_SOURCE_IPS);
  return {
    enabled: env.JNE_WEBHOOK_ENABLED === 'true',
    allowedSourceIps: [...new Set([...JNE_CONFIRMED_WEBHOOK_SOURCE_IPS, ...extra])],
  };
}

/** True when `clientIp` may call the webhook under `config` (confirmed JNE IPs when unset). */
export function isAllowedJneSource(config: JneWebhookConfig, clientIp: string | null | undefined): boolean {
  const ip = normalizeIp(clientIp);
  if (!ip) return false;
  const allowed = (config.allowedSourceIps ?? JNE_CONFIRMED_WEBHOOK_SOURCE_IPS).map((a) => normalizeIp(a)).filter(Boolean);
  return allowed.includes(ip);
}
