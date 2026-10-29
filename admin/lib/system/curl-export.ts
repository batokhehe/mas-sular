import type { IntegrationLogDetail } from '@/lib/admin';

/**
 * PURE: a cURL command that replays one stored OUTBOUND request, for an operator to
 * run locally or import into Postman. No fetch, no clipboard, no I/O.
 *
 * Faithful or nothing. The command is built only from what the log stored EXACTLY:
 * the method, `rawEndpoint` and `rawRequestBody`. When one of them is missing, or the
 * body is in a shape this cannot reproduce exactly, the result says what is missing
 * instead of guessing. Request headers are never stored, so none is invented; only
 * Content-Type is added, and only when the body itself shows which one it was.
 *
 * Never a literal credential. A body field or query parameter whose key is a
 * credential (the integration-log sanitizer's own key list) is replaced by a variable
 * the operator fills in locally: `"$JNE_API_KEY"` in a shell, `{{JNE_API_KEY}}` in
 * Postman. Every other value - including business data - is kept as stored.
 */

export type CurlFlavor = 'shell' | 'postman';

export type CurlExport =
  | { ok: true; command: string; placeholders: string[]; notes: string[]; sideEffect: SideEffect; warning: string | null }
  | { ok: false; reason: string };

type LogFields = Pick<IntegrationLogDetail, 'provider' | 'operation' | 'direction' | 'method' | 'rawEndpoint' | 'rawRequestBody'>;

/**
 * Whether replaying the operation can CHANGE something at the provider. Fail-safe:
 * only operations known to be reads are 'read'; anything else - booking, pickup,
 * cancel, cnote, charge, an operation added later - is 'write'.
 */
export type SideEffect = 'read' | 'write';
const READ_OPERATIONS = new Set(['RATE', 'QUOTE', 'TRACK', 'status']);

export function sideEffectOf(operation: string): SideEffect {
  return READ_OPERATIONS.has(operation) ? 'read' : 'write';
}

export function writeWarning(operation: string): string {
  return `${operation} MEMBUAT ATAU MENGUBAH data nyata di provider (booking, pickup, pembatalan, atau charge). Jangan dijalankan untuk debugging tanpa izin eksplisit; gunakan kredensial dan URL sandbox.`;
}

/**
 * Same pattern as SENSITIVE_KEY in backend/src/infrastructure/integration-log/
 * integration-log.sanitizer.ts (a test keeps the two identical).
 */
export const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|api[-_]?key|apikey|^username$|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|^token$|[-_]token$|token[-_]|cookie|server[-_]?key|serverkey|client[-_]?key|client[-_]?secret|webhook[-_]?secret|signature|signature[-_]?key|credential|^jwt$|session|private[-_]?key|^pin$|^otp$|^cvv$|^cvc$|card[-_]?number|^pan$|account[-_]?number/i;

function separateWords(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(separateWords(key));
}

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/** One argument, as literal text and variable references in order. */
type Part = { text: string } | { variable: string };

export const NOTE_REAL_REQUEST = 'Perintah ini mengirim request NYATA ke provider (bisa membuat booking, pickup, atau charge baru). Jalankan dengan sengaja.';
export const NOTE_HEADERS_NOT_STORED = 'Header request, termasuk autentikasi provider, tidak disimpan di log dan tidak ditambahkan di sini; tambahkan sendiri bila provider memerlukannya.';

export function buildCurl(log: LogFields, flavor: CurlFlavor): CurlExport {
  if (log.direction !== 'OUTBOUND') {
    return { ok: false, reason: 'cURL hanya untuk request keluar (OUTBOUND). Webhook masuk tidak diputar ulang dari sini.' };
  }
  const method = (log.method ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3,7}$/.test(method)) return { ok: false, reason: 'Metode HTTP tidak tersimpan untuk data ini.' };
  if (!log.rawEndpoint) return { ok: false, reason: 'URL persis tidak tersimpan untuk data ini (hanya versi tersanitasi), jadi cURL tidak dibuat.' };

  const variables = new Set<string>();
  const variableFor = (key: string) => {
    const name = `${log.provider}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    variables.add(name);
    return name;
  };

  const url = urlParts(log.rawEndpoint, variableFor);
  if ('reason' in url) return { ok: false, reason: url.reason };

  const notes = [NOTE_REAL_REQUEST, NOTE_HEADERS_NOT_STORED];
  let contentType: string | null = null;
  let body: Part[] | null = null;

  const raw = log.rawRequestBody;
  if (raw === null || raw === undefined) {
    if (!BODYLESS.has(method)) {
      return { ok: false, reason: `Body request ${method} tidak tersimpan (mis. RATE Paxel hanya menyimpan ringkasan tersanitasi), jadi cURL tidak dibuat.` };
    }
  } else if (raw === '') {
    body = [];
    notes.push('Body request tersimpan kosong; dikirim kosong.');
  } else {
    const json = jsonParts(raw, variableFor);
    if (json && 'reason' in json) return { ok: false, reason: json.reason };
    if (json) {
      body = json.parts;
      contentType = 'application/json';
    } else {
      const form = formParts(raw, variableFor);
      if (!form) return { ok: false, reason: 'Format body tidak dikenali (bukan JSON atau form-urlencoded), jadi cURL tidak dibuat agar tidak menyesatkan.' };
      if ('reason' in form) return { ok: false, reason: form.reason };
      body = form.parts;
      contentType = 'application/x-www-form-urlencoded';
    }
    notes.push(`Content-Type ${contentType} disimpulkan dari bentuk body yang tersimpan.`);
  }

  const placeholders = [...variables].sort();
  if (placeholders.length > 0) {
    notes.push(
      flavor === 'shell'
        ? `Isi dulu di shell lokal: ${placeholders.map((v) => `export ${v}=...`).join('; ')}`
        : `Isi dulu sebagai variabel environment Postman: ${placeholders.join(', ')}`,
    );
  }

  const quote = (parts: Part[]) => (flavor === 'shell' ? shellArg(parts) : postmanArg(parts));
  const lines = [`curl -X ${method} ${quote(url.parts)}`];
  if (contentType) lines.push(`  -H ${quote([{ text: `Content-Type: ${contentType}` }])}`);
  if (body) lines.push(`  --data-raw ${quote(body)}`);
  const sideEffect = sideEffectOf(log.operation);
  return { ok: true, command: lines.join(' \\\n'), placeholders, notes, sideEffect, warning: sideEffect === 'write' ? writeWarning(log.operation) : null };
}

// ------------------------------------------------------------------ quoting

function singleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Literal text single-quoted, each variable as "$NAME", concatenated into ONE shell word. */
function shellArg(parts: Part[]): string {
  if (parts.length === 0) return "''";
  return parts.map((p) => ('variable' in p ? `"$${p.variable}"` : singleQuote(p.text))).join('');
}

/** One single-quoted word with Postman `{{NAME}}` references inside. */
function postmanArg(parts: Part[]): string {
  return singleQuote(parts.map((p) => ('variable' in p ? `{{${p.variable}}}` : p.text)).join(''));
}

// ------------------------------------------------------------------ URL

function urlParts(raw: string, variableFor: (key: string) => string): { parts: Part[] } | { reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { reason: 'URL yang tersimpan tidak valid, jadi cURL tidak dibuat.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { reason: 'URL yang tersimpan bukan http(s), jadi cURL tidak dibuat.' };
  if (parsed.username || parsed.password) return { reason: 'URL yang tersimpan memuat kredensial; cURL tidak dibuat.' };
  if (raw.includes('#')) return { reason: 'URL yang tersimpan memuat fragmen (#); cURL tidak dibuat.' };
  const q = raw.indexOf('?');
  if (q < 0) return { parts: [{ text: raw }] };
  const query = pairParts(raw.slice(q + 1), variableFor);
  if (!query) return { reason: 'Query string URL tidak dapat diurai dengan pasti; cURL tidak dibuat.' };
  return { parts: mergeText([{ text: `${raw.slice(0, q)}?` }, ...query]) };
}

// ------------------------------------------------------------------ form-urlencoded

const FORM = /^[^&=\s]+=[^&\s]*(&[^&=\s]+=[^&\s]*)*$/;

function decodeFormComponent(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** `a=1&b=2`, kept byte-for-byte except the VALUE of a credential key. Null if not a clean pair list. */
function pairParts(text: string, variableFor: (key: string) => string): Part[] | null {
  if (text === '') return [];
  if (!FORM.test(text)) return null;
  const parts: Part[] = [];
  const segments = text.split('&');
  for (let i = 0; i < segments.length; i++) {
    const eq = segments[i].indexOf('=');
    const rawKey = segments[i].slice(0, eq);
    const key = decodeFormComponent(rawKey);
    if (key === null || decodeFormComponent(segments[i].slice(eq + 1)) === null) return null;
    const sep = i === 0 ? '' : '&';
    if (isSensitiveKey(key)) parts.push({ text: `${sep}${rawKey}=` }, { variable: variableFor(key) });
    else parts.push({ text: `${sep}${segments[i]}` });
  }
  return mergeText(parts);
}

function formParts(raw: string, variableFor: (key: string) => string): { parts: Part[] } | { reason: string } | null {
  const parts = pairParts(raw, variableFor);
  return parts ? { parts } : null;
}

// ------------------------------------------------------------------ JSON

/** Every credential key in the document, with the JSON type of its value. */
function sensitiveLeaves(value: unknown, out: Array<{ key: string; kind: 'string' | 'scalar' | 'nested' }>): void {
  if (Array.isArray(value)) value.forEach((v) => sensitiveLeaves(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) out.push({ key: k, kind: typeof v === 'string' ? 'string' : v !== null && typeof v === 'object' ? 'nested' : 'scalar' });
      else sensitiveLeaves(v, out);
    }
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The stored JSON text with each credential VALUE cut out and replaced by a variable.
 * The text is edited in place (never re-serialized), so everything else is byte-for-byte
 * what was sent. If the cut cannot be made exactly - a nested credential object, or a
 * key spelled with escapes the text search cannot see - nothing is produced.
 * Returns null when the body is not a JSON object/array at all.
 */
function jsonParts(raw: string, variableFor: (key: string) => string): { parts: Part[] } | { reason: string } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object') return null;
  const leaves: Array<{ key: string; kind: 'string' | 'scalar' | 'nested' }> = [];
  sensitiveLeaves(doc, leaves);
  if (leaves.some((l) => l.kind === 'nested')) return { reason: 'Body JSON memuat field kredensial berisi objek; cURL tidak dibuat agar kredensial tidak ikut tersalin.' };
  if (leaves.length === 0) return { parts: [{ text: raw }] };

  const cuts: Array<{ start: number; end: number; variable: string; quoted: boolean }> = [];
  for (const key of new Set(leaves.map((l) => l.key))) {
    const re = new RegExp(`${escapeRegExp(JSON.stringify(key))}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)`, 'g');
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      const valueStart = m.index + m[0].length - m[1].length;
      cuts.push({ start: valueStart, end: valueStart + m[1].length, variable: variableFor(key), quoted: m[1].startsWith('"') });
    }
  }
  // Every credential value found by parsing must be cut, and nothing else.
  if (cuts.length !== leaves.length) return { reason: 'Field kredensial di body JSON tidak dapat dipisahkan dengan pasti; cURL tidak dibuat.' };
  cuts.sort((a, b) => a.start - b.start);
  const parts: Part[] = [];
  let at = 0;
  for (const c of cuts) {
    parts.push({ text: raw.slice(at, c.start) + (c.quoted ? '"' : '') }, { variable: c.variable }, { text: c.quoted ? '"' : '' });
    at = c.end;
  }
  parts.push({ text: raw.slice(at) });
  return { parts: mergeText(parts) };
}

function mergeText(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if ('text' in p && p.text === '') continue;
    if ('text' in p && last && 'text' in last) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
