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

/** "2 dari 3" for a retried attempt; an application-outcome record has no attempt. */
export function formatAttempt(log: Pick<IntegrationLog, 'attempt' | 'maxAttempts'>): string {
  if (log.attempt === null) return 'hasil';
  return log.maxAttempts ? `${log.attempt} dari ${log.maxAttempts}` : String(log.attempt);
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

export const SANITIZED_SUMMARY_NOTE = 'ringkasan tersanitasi — bukan payload asli';
/** Shown under every summary: the placeholders are the logger's, not values the provider sent. */
export const PLACEHOLDER_NOTE = '[NUMBER] dan [TEXT] = nilai yang disembunyikan saat disimpan, bukan nilai dari provider. Payload asli tidak tersimpan dan tidak dapat dipulihkan.';

export type BodyView =
  | { kind: 'exact'; label: string; empty: boolean; text: string }
  | { kind: 'summary'; label: string; text: string; note: string }
  | { kind: 'none'; label: string };

/**
 * What the detail drawer shows for one body. The exact capture always wins. Without
 * one, the sanitized column is shown as what it is - a redacted summary, never the
 * payload: a Paxel RATE record keeps no raw body by design (it carries the customer's
 * street address, postal code and coordinates), only the summary the backend stored.
 * Nothing is reconstructed or re-redacted here; the stored value is only formatted.
 */
export function bodyView(title: string, raw: string | null | undefined, sanitized: unknown): BodyView {
  const exact = exactBody(raw);
  if (exact.captured) {
    return exact.empty
      ? { kind: 'exact', label: `${title}: (empty body)`, empty: true, text: '' }
      : { kind: 'exact', label: `${title} (exact)`, empty: false, text: exact.text };
  }
  if (sanitized === null || sanitized === undefined || sanitized === '') {
    return { kind: 'none', label: `${title}: tidak tercatat untuk data ini` };
  }
  // A non-JSON body is stored by the sanitizer as plain text; anything else is JSON.
  const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, null, 2);
  return { kind: 'summary', label: `${title} (${SANITIZED_SUMMARY_NOTE})`, text, note: PLACEHOLDER_NOTE };
}
