import { createHash, timingSafeEqual } from 'crypto';

/**
 * Paxel request signing (`X-Paxel-Signature`).
 *
 * Three different formulas, one per operation — they are NOT interchangeable.
 * Each is transcribed from the `X-Paxel-Signature` header documentation in the
 * Paxel eCommerce API Postman collection, and each of the collection's worked
 * examples is pinned as a test vector in paxel-signature.spec.ts. If a formula
 * is ever "tidied" (trimming, lower-casing, reordering), those vectors fail.
 *
 * Note the asymmetry, which is easy to get wrong: create takes the FIRST two
 * characters of four fields, while cancel and webhook take the LAST six of the
 * airwaybill plus the first two of one other field. Paxel does not normalise
 * the inputs, so neither do we — the substrings are taken verbatim.
 *
 * The secret is only ever an input to the hash. It is never returned, never
 * logged, and never embedded in an error message; callers get the digest alone.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface PaxelCreateSignatureInput {
  invoiceNumber: string;
  originName: string;
  destinationName: string;
  /** Name of the FIRST item in the request, in the order sent to Paxel. */
  firstItemName: string;
}

/**
 * POST /shipments
 *
 * SHA256(invoice_number[:2] + origin.name[:2] + destination.name[:2] + items[0].name[:2] + secret)
 */
export function paxelCreateSignature(input: PaxelCreateSignatureInput, secret: string): string {
  return sha256Hex(
    input.invoiceNumber.slice(0, 2) +
      input.originName.slice(0, 2) +
      input.destinationName.slice(0, 2) +
      input.firstItemName.slice(0, 2) +
      secret,
  );
}

/**
 * POST /shipments/:airwaybill_code/cancel
 *
 * SHA256(airwaybill_code[-6:] + cancellation_reason[:2] + secret)
 */
export function paxelCancelSignature(airwaybillCode: string, cancellationReason: string, secret: string): string {
  return sha256Hex(airwaybillCode.slice(-6) + cancellationReason.slice(0, 2) + secret);
}

/**
 * Inbound webhook verification.
 *
 * SHA256(airwaybill_code[-6:] + latest_status[:2] + secret)
 *
 * Consumed by verifyPaxelWebhookSignature (POST /api/v1/shipments/webhook/paxel).
 * NEEDS PAXEL CONFIRMATION: the collection documents this formula but publishes
 * no webhook digest to test it against, and does not say which secret Paxel
 * signs webhooks with. Until Paxel confirms both (with one real signed example),
 * a real push may fail verification - which fails CLOSED (401, nothing written).
 */
export function paxelWebhookSignature(airwaybillCode: string, latestStatus: string, secret: string): string {
  return sha256Hex(airwaybillCode.slice(-6) + latestStatus.slice(0, 2) + secret);
}

export type PaxelWebhookSignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' };

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Verify an inbound `X-Paxel-Signature` header against paxelWebhookSignature(),
 * over the `airwaybill_code` and `latest_status` exactly as they appear in the
 * body (Paxel does not normalise its inputs, so neither does this).
 *
 * The comparison is over the decoded 32 digest bytes with timingSafeEqual, so a
 * wrong signature leaks no timing about how much of it matched. Hex letter case is
 * representation only and is accepted either way; the algorithm is unchanged.
 * Nothing here logs or returns the header, the expected digest or the secret.
 */
export function verifyPaxelWebhookSignature(
  header: string | undefined,
  airwaybillCode: string,
  latestStatus: string,
  secret: string,
): PaxelWebhookSignatureCheck {
  const provided = header?.trim();
  if (!provided) return { ok: false, reason: 'missing' };
  if (!HEX_SHA256.test(provided)) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(paxelWebhookSignature(airwaybillCode, latestStatus, secret), 'hex');
  const actual = Buffer.from(provided, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
