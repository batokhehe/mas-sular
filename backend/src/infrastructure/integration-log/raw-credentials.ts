import { createHash } from 'crypto';
import { redactSensitivePath } from '../../common/logging/redact';
import { isSensitiveKey } from './integration-log.sanitizer';

/**
 * Credential redaction for the RAW integration-log columns (rawEndpoint,
 * rawRequestBody, rawResponseBody) - applied when a row is written AND when the
 * detail view reads one, so rows stored before this existed are masked on display
 * too (the database itself is never rewritten here).
 *
 * The raw columns exist to show an exchange exactly. So this is the narrowest cut
 * that keeps credentials out:
 *
 *   - only the VALUE of a credential key (the sanitizer's own SENSITIVE_KEY list:
 *     api_key, username, password, server_key, token, signature, ...) is replaced;
 *     every other byte - business values, PII, whitespace, key order, number
 *     formatting - is kept as it was. The text is edited in place, never parsed and
 *     re-serialized, so a JSON body stays valid JSON and an 18-digit id stays exact.
 *   - a credential holding an object or array is replaced as a whole.
 *   - `Bearer` / `Basic` credentials and `Cookie:` / `Set-Cookie:` header values are
 *     scrubbed wherever they appear as text (free-text bodies, JSON string values).
 *   - URLs: credential query values, userinfo, and the capability tokens
 *     redactSensitivePath already knows.
 *
 * What replaces a value says what was there without revealing it:
 * `[REDACTED:len32:sha256-1a2b3c4d]`. The length is always given; a short SHA-256
 * fingerprint only for values of FINGERPRINT_MIN characters or more (API keys,
 * server keys, tokens), so an operator can confirm WHICH key was sent with
 * `printf %s "$JNE_API_KEY" | sha256sum | cut -c1-8` - while short, guessable values
 * (a username, a PIN) get no hash that could be brute-forced against.
 *
 * Idempotent: an existing marker is left as it is, so read-time masking of a row
 * that was already redacted at write time changes nothing.
 */

export const FINGERPRINT_MIN = 20;
const MARKER = /^\[REDACTED(?::[^\]\s]*)?\]$/;

export function isRedactionMarker(value: string): boolean {
  return MARKER.test(value);
}

/**
 * Keys whose values are chosen by people or short by nature (usernames, passwords,
 * PINs, card and account numbers): never fingerprinted, whatever their length, since a
 * hash prefix would let a guess be confirmed offline. API keys, server keys, tokens and
 * signatures are machine-generated and can be.
 */
const NO_FINGERPRINT_KEY = /user|pass|^pin$|otp|cvv|cvc|card|^pan$|account/i;

/** The marker for one credential value; `key` (when known) decides whether a fingerprint is allowed. */
export function credentialMarker(value: string, key?: string): string {
  if (isRedactionMarker(value)) return value;
  const fingerprint = value.length >= FINGERPRINT_MIN && !(key !== undefined && NO_FINGERPRINT_KEY.test(key));
  const fp = fingerprint ? `:sha256-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}` : '';
  return `[REDACTED:len${value.length}${fp}]`;
}

/** `Bearer <token>` / `Basic <credentials>`, as text anywhere. */
const BEARER = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
/** A `Cookie:` / `Set-Cookie:` header line in text: the whole value is a credential. */
const COOKIE_LINE = /\b((?:Set-)?Cookie)(\s*:\s*)([^\r\n]+)/gi;
/** Any JWT (three base64url segments, header starting `eyJ`), as in common/logging/redact.ts. */
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** A query or fragment parameter inside text (a URL in a string, a callback link). */
const URL_PARAM = /([?&#])([A-Za-z0-9_.%-]{1,64})=([^&#\s"'<>]+)/g;
/**
 * `key=value`, `key: value`, `"key": "value"`, `'key': 'value'` in TEXT - including a
 * JSON-looking body that is not valid JSON (truncated, NDJSON, single quotes), where
 * the span reader cannot help. A quoted value runs to its closing quote; an unquoted
 * one to the next separator (`&`/space for `=`, also `,;}` for `:`).
 */
const TEXT_PAIR = /(["']?)\b([A-Za-z0-9_.-]{1,64})\1(=|\s*:\s*)(?:"((?:[^"\\]|\\.){1,512})"|'((?:[^'\\]|\\.){1,512})'|([^"'\s&]{1,512}))/g;
/**
 * Inside a JSON STRING value only keys that cannot be ordinary prose are treated as a
 * `key: value` pair: "session: pagi" or "token: none" in a note stays as written,
 * while "X-Paxel-API-Key: ..." or "password=..." does not.
 */
const STRONG_KEY = /api[-_]?key|apikey|secret|passw(or)?d|passwd|server[-_]?key|client[-_]?key|authorization|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token/i;

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * Credential SHAPES in text: Bearer/Basic, Cookie lines, JWTs, credential parameters of
 * URLs, and `key=value` / `key: value` pairs. `strict` (a free-text body) treats every
 * credential-named key as a pair; inside a JSON string value only STRONG_KEY does, so
 * business prose is not mistaken for a credential.
 */
function scrubText(text: string, strict: boolean): string {
  const isPairKey = (key: string) => (strict ? isSensitiveKey(key) : STRONG_KEY.test(key));
  return text
    .replace(BEARER, (m, scheme: string, space: string, cred: string) => (isRedactionMarker(cred) ? m : `${scheme}${space}${credentialMarker(cred, /^basic$/i.test(scheme) ? 'password' : undefined)}`))
    .replace(COOKIE_LINE, (m, name: string, sep: string, value: string) => (isRedactionMarker(value.trim()) ? m : `${name}${sep}${credentialMarker(value.trim())}`))
    .replace(JWT, (m) => credentialMarker(m))
    .replace(URL_PARAM, (m, sep: string, key: string, value: string) =>
      isSensitiveKey(decodeKey(key)) && !isRedactionMarker(value) ? `${sep}${key}=${credentialMarker(decodeKey(value), decodeKey(key))}` : m,
    )
    .replace(TEXT_PAIR, (m, q: string, key: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? '';
      // `Authorization: Bearer <marker>`: the scheme word is not the credential; the token after it was handled above.
      if (!value || !isPairKey(key) || isRedactionMarker(value) || /^(bearer|basic)$/i.test(value)) return m;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      // An unquoted value after `:` stops at , ; } so the rest of a sentence or object survives.
      const cut = !quote && sep !== '=' ? (/^[^,;}]+/.exec(value)?.[0] ?? value) : value;
      if (isRedactionMarker(cut)) return m;
      return `${q}${key}${q}${sep}${quote}${credentialMarker(cut, key)}${quote}${value.slice(cut.length)}`;
    });
}

// ------------------------------------------------------------------ JSON, by span

type Span = { start: number; end: number };
type Node =
  | (Span & { type: 'string' | 'number' | 'literal' })
  | (Span & { type: 'array'; items: Node[] })
  | (Span & { type: 'object'; entries: Array<{ key: string; value: Node }> });

/** A strict JSON reader that records where every value is. Null if the text is not exactly one JSON value. */
function scanJson(text: string): Node | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const fail = (): never => {
    throw new SyntaxError('not json');
  };
  const str = (): Node => {
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
    return { type: 'string', start, end: i };
  };
  const value = (): Node => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i++;
      const entries: Array<{ key: string; value: Node }> = [];
      ws();
      if (text[i] === '}') return { type: 'object', start, end: ++i, entries };
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        const key = JSON.parse(text.slice(k.start, k.end)) as string;
        ws();
        if (text[i++] !== ':') fail();
        entries.push({ key, value: value() });
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return { type: 'object', start, end: ++i, entries };
        else fail();
      }
    }
    if (c === '[') {
      i++;
      const items: Node[] = [];
      ws();
      if (text[i] === ']') return { type: 'array', start, end: ++i, items };
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return { type: 'array', start, end: ++i, items };
        else fail();
      }
    }
    const lit = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!lit) fail();
    i += lit![0].length;
    return { type: /^[tfn]/.test(lit![0]) ? 'literal' : 'number', start, end: i };
  };
  try {
    const root = value();
    ws();
    return i === text.length ? root : null;
  } catch {
    return null;
  }
}

function redactJson(text: string, root: Node): string {
  const cuts: Array<Span & { with: string }> = [];
  const visit = (node: Node) => {
    if (node.type === 'object') {
      for (const { key, value } of node.entries) {
        if (isSensitiveKey(key)) cut(key, value);
        else visit(value);
      }
    } else if (node.type === 'array') node.items.forEach(visit);
    else if (node.type === 'string') {
      // Decoded, scrubbed, re-encoded - and only when a credential shape was found,
      // so every other string literal keeps its exact escapes.
      const decoded = JSON.parse(text.slice(node.start, node.end)) as string;
      const scrubbed = scrubText(decoded, false);
      if (scrubbed !== decoded) cuts.push({ start: node.start, end: node.end, with: JSON.stringify(scrubbed) });
    }
  };
  const cut = (key: string, value: Node) => {
    const raw = text.slice(value.start, value.end);
    if (value.type === 'string') {
      const decoded = JSON.parse(raw) as string;
      // An empty value hides nothing; a marker is already redacted.
      if (decoded === '' || isRedactionMarker(decoded)) return;
      // Paxel/JNE `signature` / `pdo_signature` hold the proof-of-delivery IMAGE URL, not
      // a credential: keep the link, minus any credential it carries in its query.
      if (/signature/i.test(key) && /^https?:\/\/\S+$/i.test(decoded)) {
        const url = redactRawUrl(decoded)!;
        if (url !== decoded) cuts.push({ ...value, with: JSON.stringify(url) });
        return;
      }
      cuts.push({ ...value, with: JSON.stringify(credentialMarker(decoded, key)) });
    } else if (value.type === 'number') cuts.push({ ...value, with: JSON.stringify(credentialMarker(raw, key)) });
    else if (value.type === 'object' || value.type === 'array') cuts.push({ ...value, with: JSON.stringify(`[REDACTED:${value.type}]`) });
    // true / false / null carry no secret and keep their meaning.
  };
  visit(root);
  let out = text;
  for (const c of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.with + out.slice(c.end);
  return out;
}

// ------------------------------------------------------------------ form / query

const FORM = /^[^&=\s]+=[^&\s]*(&[^&=\s]+=[^&\s]*)*$/;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** `a=1&b=2` with each credential VALUE replaced; null when the text is not a clean pair list. */
function redactPairs(text: string): string | null {
  if (!FORM.test(text)) return null;
  return text
    .split('&')
    .map((segment) => {
      const eq = segment.indexOf('=');
      const key = decode(segment.slice(0, eq));
      const value = decode(segment.slice(eq + 1));
      if (key === null || value === null || !isSensitiveKey(key) || isRedactionMarker(value)) return segment;
      return `${segment.slice(0, eq)}=${credentialMarker(value, key)}`;
    })
    .join('&');
}

// ------------------------------------------------------------------ public

/** A raw request/response body with credential values replaced; everything else byte-for-byte. */
export function redactRawBody(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  if (body === '') return '';
  const json = scanJson(body);
  if (json && (json.type === 'object' || json.type === 'array')) return redactJson(body, json);
  return redactPairs(body) ?? scrubText(body, true);
}

/** A raw URL with userinfo, credential query values and capability path tokens replaced. */
export function redactRawUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return url ?? null;
  const hashAt = url.indexOf('#');
  const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = beforeHash.indexOf('?');
  let base = q >= 0 ? beforeHash.slice(0, q) : beforeHash;
  const query = q >= 0 ? beforeHash.slice(q + 1) : null;

  base = base.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i, (_m, scheme: string, userinfo: string) => `${scheme}${credentialMarker(decode(userinfo) ?? userinfo, 'userinfo')}@`);
  // Capability tokens in the PATH (upload / invoice links, JWT-shaped segments).
  base = redactSensitivePath(base);

  let redactedQuery = query;
  if (query !== null && query !== '') {
    redactedQuery = query
      .split('&')
      .map((segment) => {
        const eq = segment.indexOf('=');
        if (eq < 0) return segment;
        const key = decode(segment.slice(0, eq));
        const value = decode(segment.slice(eq + 1));
        if (key === null || value === null || !isSensitiveKey(key) || isRedactionMarker(value)) return segment;
        return `${segment.slice(0, eq)}=${credentialMarker(value, key)}`;
      })
      .join('&');
  }
  // A fragment can carry credentials too (`#access_token=...` in OAuth-style callbacks).
  const redactedFragment = fragment.includes('=') ? fragment.replace(URL_PARAM, (m, sep: string, key: string, value: string) =>
    isSensitiveKey(decodeKey(key)) && !isRedactionMarker(value) ? `${sep}${key}=${credentialMarker(decodeKey(value), decodeKey(key))}` : m,
  ) : fragment;
  return `${base}${redactedQuery === null ? '' : `?${redactedQuery}`}${redactedFragment}`;
}
