export const IDEMPOTENCY_CONFIG = 'IDEMPOTENCY_CONFIG';

export interface IdempotencyConfig {
  /** Gate for checkout idempotency. Defaults to false (Phase A optional rollout). */
  checkoutEnabled: boolean;
  /** How long a key (and its replayable response) is retained. */
  retentionMs: number;
  /** A PROCESSING row older than this is treated as abandoned and reclaimable. */
  reclaimMs: number;
  /** Retry-After value (seconds) returned for an in-progress (PROCESSING) request. */
  retryAfterSeconds: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function loadIdempotencyConfig(env: NodeJS.ProcessEnv = process.env): IdempotencyConfig {
  return {
    checkoutEnabled: env.CHECKOUT_IDEMPOTENCY_ENABLED === 'true',
    retentionMs: positiveInt(env.IDEMPOTENCY_RETENTION_MS, 48 * 60 * 60 * 1000), // 48h
    reclaimMs: positiveInt(env.IDEMPOTENCY_RECLAIM_MS, 120 * 1000), // 120s
    retryAfterSeconds: positiveInt(env.IDEMPOTENCY_RETRY_AFTER_SECONDS, 2),
  };
}
