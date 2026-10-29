/**
 * The stored shape of a provider response for a call whose request carried customer
 * data (IntegrationCallContext.redactedRequest - Paxel quotes).
 *
 * The general sanitizer redacts by KEY, which is the right tool for a booking but not
 * for a quote: a provider error can repeat what it was sent in free text ("address
 * Jl. ... is outside the service area"), or echo coordinates and postal codes under
 * keys no list anticipates. So this is an ALLOWLIST, not a blocklist:
 *
 *   - structure is kept: key names (identifier-shaped only) and nesting, so it is
 *     still visible WHICH field a provider objected to;
 *   - booleans and null are kept;
 *   - a number is kept only under a status/price key; elsewhere it is "[NUMBER]"
 *     (coordinates, postal codes and house numbers are numbers);
 *   - under a `time_*` key, a string that is exactly a clock time or a date-time is
 *     kept (a quote's pickup/delivery window); any other value there is "[TEXT]";
 *   - a string is kept only if it is short, has no digit, no token-shaped run, and
 *     contains none of the values this request actually sent; anything else is "[TEXT]".
 *
 * No pattern list of "sensitive strings" is attempted: what is kept is decided by
 * what is known to be safe, and what was sent is known exactly.
 */

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const NUMERIC_KEYS = new Set([
  'code',
  'status',
  'status_code',
  'statusCode',
  'error_code',
  'errorCode',
  'response_code',
  'fixed_price',
  'small_price',
  'medium_price',
  'large_price',
  'custom_price',
  'price',
  'total_price',
]);
/** Paxel's service window fields: time_pickup_start, time_delivery_end, ... */
const TIME_KEY = /^time_/;
/** HH:MM[:SS], optionally after a YYYY-MM-DD date (space or T) and before Z/±HH:MM. Nothing else. */
const TIME_VALUE = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T])?([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;
const MAX_TEXT = 200;
const MAX_DEPTH = 5;
const MAX_ITEMS = 10;

export const REDACTED_TEXT = '[TEXT]';
export const REDACTED_NUMBER = '[NUMBER]';

/**
 * Every string the request carried, lower-cased, that a provider echoing it back would
 * leak: body leaves (except the location levels that are already in the summary) and
 * header values (the API key).
 */
export function sentValues(body: string | undefined, headers: Record<string, string> | undefined, keep: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v).trim().toLowerCase();
    if (s.length >= 3) out.add(s);
  };
  const walk = (value: unknown, key?: string) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (typeof value === 'object') Object.entries(value as Record<string, unknown>).forEach(([k, v]) => walk(v, k));
    else if (!key || !keep.has(key)) add(value);
  };
  if (body) {
    try {
      walk(JSON.parse(body));
    } catch {
      add(body);
    }
  }
  Object.values(headers ?? {}).forEach(add);
  return [...out];
}

/** A whitespace-free run this long is token-shaped (API key, bearer token, JWT), never prose. */
const TOKEN_LIKE = /\S{24,}/;

function safeText(value: string, sent: readonly string[]): boolean {
  if (value.length > MAX_TEXT || /\d/.test(value) || value.includes('@') || TOKEN_LIKE.test(value)) return false;
  const lower = value.toLowerCase();
  return !sent.some((s) => lower.includes(s));
}

function summarize(value: unknown, sent: readonly string[], key: string | undefined, depth: number): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return key !== undefined && NUMERIC_KEYS.has(key) ? value : REDACTED_NUMBER;
  if (typeof value === 'string') {
    if (key !== undefined && NUMERIC_KEYS.has(key) && /^\d{1,6}$/.test(value)) return value;
    if (key !== undefined && TIME_KEY.test(key) && TIME_VALUE.test(value) && !sent.some((s) => value.toLowerCase().includes(s))) return value;
    return safeText(value, sent) ? value : REDACTED_TEXT;
  }
  if (depth >= MAX_DEPTH) return REDACTED_TEXT;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => summarize(v, sent, key, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SAFE_KEY.test(k)) out[k] = summarize(v, sent, k, depth + 1);
    }
    return out;
  }
  return REDACTED_TEXT;
}

/** The allowlisted summary of a response body (JSON or not) for a redacted call. */
export function summarizeRedactedResponse(text: string, sent: readonly string[]): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (an HTML error page, a bare string): only its size is kept.
    return { nonJson: true, length: text.length };
  }
  return summarize(parsed, sent, undefined, 0);
}
