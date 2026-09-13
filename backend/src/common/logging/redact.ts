// Capability secrets that must never reach logs. The payment upload token rides
// in the URL path (GET/POST /payments/upload/:token), and so does the P2 #14
// customer invoice token (GET /invoices/:token); redact those segments so they do
// not land in pino-http request logs, the SystemLog request log or error logs.
const UPLOAD_TOKEN_PATH = /(\/payments\/upload\/)[^/?#]+/g;
const INVOICE_TOKEN_PATH = /(\/invoices\/)[^/?#]+/g;

/** Replace capability-token path segments with [REDACTED], preserving the rest of the URL. */
export function redactSensitivePath<T extends string | undefined>(url: T): T {
  if (!url) return url;
  return url.replace(UPLOAD_TOKEN_PATH, '$1[REDACTED]').replace(INVOICE_TOKEN_PATH, '$1[REDACTED]') as T;
}

/**
 * pino-http also logs the matched route params, and under URI versioning Express
 * exposes the whole path there (`params.path = ['v1', 'invoices', '<token>']`), so
 * the URL redaction alone did not keep the capability tokens out of request logs.
 * Path segments are re-joined and passed through redactSensitivePath; any param
 * whose NAME looks like a token is masked outright. Everything else is kept.
 */
export function redactSensitiveParams(params: unknown): unknown {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return params;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (/token/i.test(key)) out[key] = '[REDACTED]';
    else if (Array.isArray(value)) out[key] = redactSensitivePath(`/${value.map(String).join('/')}`).slice(1).split('/');
    else if (typeof value === 'string') out[key] = redactSensitivePath(`/${value}`).slice(1);
    else out[key] = value;
  }
  return out;
}

/**
 * pino-http `redact` option. Credential headers are fully censored - the auth
 * header, cookies, and the Paxel webhook's `X-Paxel-Signature` (a request
 * signature: never worth a log line). The request URL and the route params are
 * partially censored so capability tokens (payment upload, P2 #14 invoice) never
 * reach request logs - pino-http logs `req.params`, which carries the path too.
 */
export const PINO_HTTP_REDACT = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-paxel-signature"]', 'req.url', 'req.params'],
  censor: (value: unknown, path: string[]): unknown => {
    const field = path[path.length - 1];
    if (field === 'url') return redactSensitivePath(String(value));
    if (field === 'params') return redactSensitiveParams(value);
    return '[Redacted]';
  },
};

// Query-string keys whose VALUES must never be persisted (the SSE stream carries
// the admin JWT as ?token=, and future endpoints may carry similar credentials).
const SENSITIVE_QUERY_KEY = /token|secret|password|authorization|api[-_]?key/i;

/**
 * Shallow-redact credential-bearing values in a parsed query object before it is
 * logged. Non-objects pass through untouched; matching keys keep their presence
 * (useful for debugging) but lose their value.
 */
export function redactSensitiveQuery<T>(query: T): T {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return query;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    out[key] = SENSITIVE_QUERY_KEY.test(key) ? '[REDACTED]' : value;
  }
  return out as T;
}

// Correlation ids we accept from clients: UUID-like/safe token, bounded length.
// Anything else (huge strings, log-injection attempts) is replaced server-side.
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{8,64}$/;

/** Return the inbound X-Request-Id only when it is a safe correlation token. */
export function acceptableRequestId(raw: unknown): string | null {
  return typeof raw === 'string' && REQUEST_ID_SHAPE.test(raw) ? raw : null;
}
