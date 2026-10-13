import { redactJwts, redactSensitivePath } from '../../common/logging/redact';

/**
 * The ONE sanitizer for everything written to IntegrationApiLog.
 *
 * Rules, in order:
 *   1. Headers are never passed in at all - the Paxel API key, the Midtrans
 *      `Authorization: Basic`, cookies and webhook signatures live there, so not
 *      capturing them is stronger than filtering them.
 *   2. Credential-looking KEYS are replaced wherever they appear, at any depth.
 *      JNE is the reason this must cover bodies and not just headers: it
 *      authenticates with `username` and `api_key` as form fields.
 *   3. Personal data that adds nothing to troubleshooting (recipient name, phone,
 *      address, email) is replaced; the operational fields beside it (order number,
 *      postal code, destination code, service, weight, amount, provider status,
 *      cnote/AWB) are kept, because those are what a failure is diagnosed from.
 *   4. Every remaining string is scrubbed of JWT-shaped substrings and capped.
 *   5. The whole payload is capped; over the cap it is replaced by a marker object
 *      that says so explicitly rather than silently dropping data.
 *
 * Reuses `common/logging/redact.ts` (redactJwts / redactSensitivePath) so there is
 * exactly one redaction vocabulary in the codebase.
 */

export const REDACTED = '[REDACTED]';
export const REDACTED_PII = '[REDACTED_PII]';
export const TRUNCATED_MARKER = '[TRUNCATED]';

/**
 * Keys whose VALUE must never be persisted. Superset of `SENSITIVE_QUERY_KEY` in
 * common/logging/redact.ts, extended with the provider-specific credential names
 * (JNE `api_key`/`username`, Midtrans `server_key`, webhook secrets) and the
 * payment-instrument fields that must never reach a log line.
 */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|api[-_]?key|apikey|^username$|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|^token$|[-_]token$|token[-_]|cookie|server[-_]?key|serverkey|client[-_]?key|client[-_]?secret|webhook[-_]?secret|signature|signature[-_]?key|credential|^jwt$|session|private[-_]?key|^pin$|^otp$|^cvv$|^cvc$|card[-_]?number|^pan$|account[-_]?number/i;

/**
 * Split camelCase into separated words so a key is matched on its PARTS, not on the
 * punctuation that happens to separate them: `cardTokenId` -> `card_Token_Id`, which
 * the `token[-_]` alternative above then matches exactly as it matches `card_token_id`.
 * `tokenized` stays one word and therefore stays NON-sensitive, which is the point:
 * only a key whose own word IS "token" is a credential.
 */
function separateWords(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
}

/** A credential-bearing key, in any casing or separator style. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(separateWords(key));
}

/** A key carrying personal data with no diagnostic value. */
export function isPiiKey(key: string): boolean {
  return PII_KEY.test(key) || PII_KEY.test(separateWords(key));
}

/**
 * Keys carrying personal data with no diagnostic value. Matched on the WHOLE key,
 * including JNE `/pickupcashless` naming (`RECEIVER_ADDR1`, `SHIPPER_CONTACT`,
 * `PICKUP_PIC`, `PICKUP_PIC_PHONE`, `PICKUP_ADDRESS`),
 * so operational look-alikes are untouched: `service_name`, `provider_name`,
 * `merchant_name`, `city_name` and `postal_code` all survive.
 */
const PII_KEY =
  /^(?:(?:receiver|recipient|sender|shipper|origin|destination|customer|billing|shipping|consignee|pickup|return|pic)[-_]?)?(?:full[-_]?)?(?:name|first[-_]?name|last[-_]?name|phone|phone[-_]?number|mobile|whatsapp|wa|email|e[-_]?mail|addr\d?|address|address[-_]?detail|address[-_]?line\d?|street|notes?|note|contact|pic|pic[-_]?phone)$/i;

export interface SanitizeOptions {
  /** Maximum serialized size of the stored payload, in bytes. */
  maxBytes: number;
  /** Maximum length of any single string value. */
  maxStringLength: number;
  /** Maximum nesting depth explored before the branch is summarized. */
  maxDepth: number;
  /** Maximum array items kept. */
  maxArrayItems: number;
}

export const DEFAULT_SANITIZE_OPTIONS: SanitizeOptions = {
  maxBytes: 16_384,
  maxStringLength: 2_000,
  maxDepth: 8,
  maxArrayItems: 50,
};

export type SanitizedPayload = Record<string, unknown> | unknown[] | string | null;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function sanitizeString(value: string, opts: SanitizeOptions): string {
  const scrubbed = redactJwts(value);
  return scrubbed.length > opts.maxStringLength
    ? `${scrubbed.slice(0, opts.maxStringLength)}…${TRUNCATED_MARKER}`
    : scrubbed;
}

/** Recursively replace credential and PII values. Structure is preserved. */
export function sanitizeValue(value: unknown, opts: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeString(value, opts);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;

  if (depth >= opts.maxDepth) return TRUNCATED_MARKER;

  if (Array.isArray(value)) {
    const kept = value.slice(0, opts.maxArrayItems).map((item) => sanitizeValue(item, opts, depth + 1));
    if (value.length > opts.maxArrayItems) kept.push(`${TRUNCATED_MARKER} ${value.length - opts.maxArrayItems} more item(s)`);
    return kept;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) out[key] = REDACTED;
      else if (isPiiKey(key)) out[key] = REDACTED_PII;
      else out[key] = sanitizeValue(item, opts, depth + 1);
    }
    return out;
  }

  return sanitizeString(String(value), opts);
}

/** Enforce the payload size cap, replacing an oversized body with an explicit marker. */
function capPayload(value: unknown, opts: SanitizeOptions): SanitizedPayload {
  if (value === null || value === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return { truncated: true, marker: TRUNCATED_MARKER, reason: 'payload is not serializable' };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= opts.maxBytes) {
    // Round-trip so the JSON column can never reject an `undefined` (the same
    // guarantee LogService.sanitize() gives SystemLog.metadata).
    return JSON.parse(serialized) as SanitizedPayload;
  }
  return {
    truncated: true,
    marker: TRUNCATED_MARKER,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    limitBytes: opts.maxBytes,
    preview: `${serialized.slice(0, Math.min(opts.maxBytes, 2_000))}…${TRUNCATED_MARKER}`,
  };
}

/**
 * Sanitize an already-parsed value (a webhook DTO, a provider object). Returns a
 * value safe for the `sanitizedRequest` / `sanitizedResponse` JSON columns.
 */
export function sanitizePayload(value: unknown, opts: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS): SanitizedPayload {
  return capPayload(sanitizeValue(value, opts), opts);
}

/**
 * Sanitize a RAW HTTP body string. JSON is parsed and sanitized field by field;
 * `application/x-www-form-urlencoded` is parsed into fields FIRST - otherwise JNE's
 * `username=…&api_key=…` would be stored verbatim as one opaque string. Anything
 * else is kept as scrubbed, capped text.
 */
export function sanitizeBody(
  body: string | undefined | null,
  contentType?: string,
  opts: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS,
): SanitizedPayload {
  if (body === undefined || body === null || body === '') return null;

  const isForm = /x-www-form-urlencoded/i.test(contentType ?? '');
  if (isForm || (!contentType && looksLikeForm(body))) {
    const params = new URLSearchParams(body);
    const fields: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) fields[key] = value;
    return capPayload(sanitizeValue(fields, opts), opts);
  }

  try {
    return capPayload(sanitizeValue(JSON.parse(body), opts), opts);
  } catch {
    return capPayload(sanitizeString(body, opts), opts);
  }
}

/** A form body has key=value pairs and no JSON opener. */
function looksLikeForm(body: string): boolean {
  return !/^\s*[[{]/.test(body) && /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body.trim());
}

/**
 * Credential/PII pairs inside FREE TEXT. A provider's error body arrives as an
 * opaque, often mid-structure-truncated string (the transports keep the first 300
 * characters), so it cannot be parsed - but the pairs inside it must still be
 * replaced before the text is persisted as `errorMessage`.
 *
 * THREE narrow passes rather than one clever pattern: each pass anchors on the
 * separator style, so a key is always examined as a key. (A single combined pattern
 * consumed `username=masular` as the VALUE of the preceding `400:` and never looked
 * at it - caught by the regression test below.)
 */
const FORM_PAIR = /([A-Za-z0-9_.-]{1,64})=([^&\s]{1,512})/g;
const JSON_PAIR = /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"?([^",}\]]{0,512})"?/g;
const COLON_PAIR = /\b([A-Za-z0-9_.-]{1,64})(\s*:\s+)([^,;}\s]{1,512})/g;

/** `Authorization: Bearer <token>` / `Basic <credentials>` in free text. */
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** The replacement for one matched pair, or null when the key is harmless. */
function pairReplacement(key: string): string | null {
  if (isSensitiveKey(key)) return REDACTED;
  if (isPiiKey(key)) return REDACTED_PII;
  return null;
}

/**
 * Sanitize a FREE-TEXT provider error for persistence in `IntegrationApiLog.errorMessage`.
 *
 * Same policy as the persisted payload columns - credential keys replaced, personal
 * data replaced, JWT and Bearer/Basic shapes scrubbed - applied with text matching
 * because the input is a fragment rather than a document. The provider's own
 * diagnostic words (status codes, messages, reasons) are deliberately preserved:
 * they are the reason the column exists.
 *
 * This NEVER touches the error a provider THROWS; only the stored representation.
 */
export function sanitizeErrorText(text: string | null | undefined, maxLength = 512): string | null {
  if (text === null || text === undefined || text === '') return null;

  const scrubbed = redactJwts(text)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(FORM_PAIR, (match, key: string, _value: string) => {
      const replacement = pairReplacement(key);
      return replacement === null ? match : `${key}=${replacement}`;
    })
    .replace(JSON_PAIR, (match, key: string, separator: string, _value: string) => {
      const replacement = pairReplacement(key);
      return replacement === null ? match : `"${key}"${separator}"${replacement}"`;
    })
    .replace(COLON_PAIR, (match, key: string, separator: string, _value: string) => {
      const replacement = pairReplacement(key);
      return replacement === null ? match : `${key}${separator}${replacement}`;
    });

  if (scrubbed.length <= maxLength) return scrubbed;
  // The marker counts towards the limit: this value goes into a VarChar column, so
  // "at most maxLength" has to include it or the insert would fail on overflow.
  const suffix = `…${TRUNCATED_MARKER}`;
  return `${scrubbed.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

/** Host + path, with capability tokens and credential query values removed. */
export function sanitizeEndpoint(url: string | undefined | null): string | null {
  if (!url) return null;
  const redacted = redactSensitivePath(url);
  return redacted.length > 512 ? redacted.slice(0, 512) : redacted;
}
