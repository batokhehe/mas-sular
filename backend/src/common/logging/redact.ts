// Capability secrets that must never reach logs. The payment upload token rides
// in the URL path (GET/POST /payments/upload/:token), and so does the P2 #14
// customer invoice token (GET /invoices/:token); redact those segments so they do
// not land in pino-http request logs, the SystemLog request log or error logs.
const UPLOAD_TOKEN_PATH = /(\/payments\/upload\/)[^/?#]+/g;
const INVOICE_TOKEN_PATH = /(\/invoices\/)[^/?#]+/g;

/** Any JWT (three base64url segments, header starting `eyJ`) wherever it appears. */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** Scrub every JWT-shaped substring. Last line of defence for free-form text. */
export function redactJwts(text: string): string {
  return text.replace(JWT_SHAPE, '[REDACTED_JWT]');
}

/** Replace the VALUE of credential-like query parameters, keeping the key for debugging. */
function redactQueryString(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep the raw key
      }
      return eq !== -1 && SENSITIVE_QUERY_KEY.test(key) ? `${rawKey}=[REDACTED]` : pair;
    })
    .join('&');
  return `${url.slice(0, q + 1)}${redacted}${hash === -1 ? '' : url.slice(hash)}`;
}

/**
 * Make a URL safe to log: capability-token path segments, credential-like query
 * VALUES (H2 - the admin SSE stream used to carry the JWT as ?token=) and any
 * JWT-shaped substring are all replaced. Used for pino's req.url, the SystemLog
 * request log and the exception filter.
 */
export function redactSensitivePath<T extends string | undefined>(url: T): T {
  if (!url) return url;
  const pathRedacted = url.replace(UPLOAD_TOKEN_PATH, '$1[REDACTED]').replace(INVOICE_TOKEN_PATH, '$1[REDACTED]');
  return redactJwts(redactQueryString(pathRedacted)) as T;
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
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-paxel-signature"]',
    'req.headers["x-csrf-token"]',
    'req.url',
    'req.params',
    // H2: pino-http logs the parsed query separately from the URL.
    'req.query',
    // H2: the admin login response's Set-Cookie carries the access JWT (found in
    // the staging logs during the audit follow-up).
    'res.headers["set-cookie"]',
  ],
  censor: (value: unknown, path: string[]): unknown => {
    const field = path[path.length - 1];
    if (field === 'url') return redactSensitivePath(String(value));
    if (field === 'params') return redactSensitiveParams(value);
    if (field === 'query') return redactSensitiveQuery(value);
    return '[Redacted]';
  },
};

// Query-string keys whose VALUES must never be persisted (the SSE stream carries
// the admin JWT as ?token=, and future endpoints may carry similar credentials).
const SENSITIVE_QUERY_KEY = /token|secret|password|passwd|authorization|api[-_]?key|jwt|session|^sid$|^auth$|signature|credential/i;

/**
 * Shallow-redact credential-bearing values in a parsed query object before it is
 * logged. Non-objects pass through untouched; matching keys keep their presence
 * (useful for debugging) but lose their value.
 */
export function redactSensitiveQuery<T>(query: T): T {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return query;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    out[key] = SENSITIVE_QUERY_KEY.test(key) ? '[REDACTED]' : typeof value === 'string' ? redactJwts(value) : value;
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
