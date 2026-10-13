/**
 * PURE diff/snapshot helpers for the Audit Trail. No I/O — unit-testable alone.
 */
import { Prisma } from '@prisma/client';

export interface DiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

// Volatile/technical fields never worth auditing as changes.
const IGNORED_KEYS = new Set(['updatedAt', 'createdAt', 'lastLogin', 'deletedAt', 'expiresAt', 'lockedUntil', 'nextAttemptAt']);
const isIgnored = (key: string): boolean => IGNORED_KEYS.has(key) || /(At|Timestamp)$/.test(key);

// Secrets are stripped from snapshots BEFORE persisting (never stored).
// `invoiceUrl` (P2 #14) carries the customer invoice capability token.
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'token', 'tokenHash', 'secret', 'apiKey', 'authorization', 'refreshToken', 'accessToken', 'webhookPayload', 'invoiceUrl']);

/**
 * Prisma Decimal columns (Outlet/Address latitude+longitude, Product.rating) are
 * decimal.js instances whose OWN keys include `constructor`. Walked as a plain
 * object they became `{ constructor: [Function], d, e, s }`, which Prisma cannot
 * store in the Json column - so every audited Outlet/Product write lost its row.
 * Keep the numeric meaning: a JSON number when it round-trips exactly, otherwise
 * the exact decimal string (never a silently rounded number).
 */
function decimalToJson(value: Prisma.Decimal): number | string {
  const n = value.toNumber();
  return Number.isFinite(n) && new Prisma.Decimal(n).equals(value) ? n : value.toString();
}

/**
 * Deep-copy a snapshot with secrets removed and keys sorted (stable pretty JSON).
 * The result is always JSON-serializable: Decimal -> number/exact string, BigInt ->
 * string, Date -> ISO string; functions (never data) are dropped.
 */
export function sanitizeSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Prisma.Decimal.isDecimal(value)) return decimalToJson(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeSnapshot(v));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (SENSITIVE_KEYS.has(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'function') continue;
    out[key] = sanitizeSnapshot(v);
  }
  return out;
}

const normalized = (v: unknown): string => JSON.stringify(v instanceof Date ? v.toISOString() : v ?? null);

/**
 * Generic shallow diff of two object snapshots: ignored/timestamp keys skipped,
 * fields sorted, nested values compared structurally. Returns [] when either side
 * is missing (CREATE/DELETE show full snapshots instead of a field diff).
 */
export function computeDiff(before: unknown, after: unknown): DiffEntry[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !isIgnored(k) && !SENSITIVE_KEYS.has(k)).sort();
  const diff: DiffEntry[] = [];
  for (const field of keys) {
    if (normalized(b[field]) !== normalized(a[field])) {
      diff.push({ field, before: b[field] ?? null, after: a[field] ?? null });
    }
  }
  return diff;
}

/** Stable, human-readable JSON for storage/display. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(sanitizeSnapshot(value), null, 2);
}

// Common display-name fields across our entities, in preference order.
const NAME_FIELDS = ['name', 'title', 'orderNumber', 'code', 'email', 'bankName', 'template', 'label'];

/** Best-effort display name for an entity snapshot (null when nothing matches). */
export function deriveEntityName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const record = snapshot as Record<string, unknown>;
  for (const field of NAME_FIELDS) {
    const v = record[field];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 255);
  }
  return null;
}
