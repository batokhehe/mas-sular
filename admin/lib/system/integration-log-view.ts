import type { IntegrationLog, IntegrationLogDetail, IntegrationOutcome, IntegrationProvider } from '@/lib/admin';

/**
 * PURE view helpers for Admin → System → Integration Logs, so the table's
 * vocabulary and grouping are unit-testable without React. No fetch, no I/O.
 */

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ['PAXEL', 'JNE', 'MIDTRANS'];

export const INTEGRATION_OUTCOMES: IntegrationOutcome[] = ['OK', 'HTTP_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'PARSE_FAILED', 'REJECTED'];

/**
 * Operations per provider, in each provider's OWN vocabulary (decision 5): JNE says
 * RATE / PICKUP_CASHLESS / CANCEL_CNOTE, Midtrans says charge / status / cancel /
 * expire. Nothing is renamed for cosmetic consistency.
 */
export const INTEGRATION_OPERATIONS: Record<IntegrationProvider, string[]> = {
  PAXEL: ['RATE', 'CREATE_SHIPMENT', 'CANCEL', 'TRACK', 'WEBHOOK'],
  // PICKUP_CASHLESS is JNE booking now; GENERATE_CNOTE stays filterable for historical records.
  JNE: ['RATE', 'PICKUP_CASHLESS', 'GENERATE_CNOTE', 'CANCEL_CNOTE', 'TRACK', 'WEBHOOK'],
  MIDTRANS: ['charge', 'status', 'cancel', 'expire', 'WEBHOOK'],
};

/** Options for the Operation filter: every operation, or one provider's own list. */
export function operationOptions(provider?: IntegrationProvider | ''): string[] {
  if (provider) return INTEGRATION_OPERATIONS[provider];
  return [...new Set(INTEGRATION_PROVIDERS.flatMap((p) => INTEGRATION_OPERATIONS[p]))];
}

export type OutcomeTone = 'ok' | 'warn' | 'error';

/** OK is green; a provider refusal is amber; anything broken is red. */
export function outcomeTone(outcome: IntegrationOutcome): OutcomeTone {
  if (outcome === 'OK') return 'ok';
  if (outcome === 'REJECTED') return 'warn';
  return 'error';
}

export function httpStatusTone(status: number | null): OutcomeTone | 'none' {
  if (status === null) return 'none';
  if (status < 400) return 'ok';
  if (status < 500) return 'warn';
  return 'error';
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${ms}ms`;
}

/** "2 of 3" for a retried attempt; an application-outcome record has no attempt. */
export function formatAttempt(log: Pick<IntegrationLog, 'attempt' | 'maxAttempts'>): string {
  if (log.attempt === null) return 'result';
  return log.maxAttempts ? `${log.attempt} of ${log.maxAttempts}` : String(log.attempt);
}

/** The business identifier to show in the Order column. */
export function contextLabel(log: Pick<IntegrationLog, 'orderId' | 'paymentId' | 'shipmentId' | 'correlationId'>): string {
  return log.correlationId ?? log.orderId ?? log.paymentId ?? log.shipmentId ?? '—';
}

/**
 * The request URL EXACTLY as called. Records written before exact capture existed
 * have no rawEndpoint; their stored endpoint is the only URL there is.
 */
export function exactEndpoint(log: Pick<IntegrationLogDetail, 'rawEndpoint' | 'endpoint'>): string | null {
  return log.rawEndpoint ?? log.endpoint;
}

export type ExactBody = { captured: false } | { captured: true; empty: boolean; text: string };

/**
 * A request/response body for the detail view, EXACTLY as captured: the text is
 * returned unchanged - no JSON pretty-printing, trimming, masking or truncation.
 * `null` means the body was not captured for this record; "" is a real empty body.
 */
export function exactBody(value: string | null | undefined): ExactBody {
  if (value === null || value === undefined) return { captured: false };
  return { captured: true, empty: value.length === 0, text: value };
}
