import { createHash } from 'crypto';
import { canonicalJson, sanitizeMediaUrl } from './jne-webhook';

/**
 * Paxel webhook - PURE domain logic (no I/O, no DB, no logging).
 *
 * Built from the one real Paxel webhook example available (POST, application/json,
 * `X-Paxel-Signature` header) and nothing beyond it. That example establishes the
 * FIELD NAMES and their JSON types; it does NOT establish:
 *   - units of `actual_price` / `actual_weight` / `money.collect_money` - kept exactly
 *     as sent (raw string + number), never converted;
 *   - the time zone of `delivery_datetime` / `logs.created_datetime` - kept verbatim,
 *     never turned into an instant;
 *   - whether the media fields are URLs - only absolute http(s) links are stored
 *     (stored and linked, never fetched or proxied); anything else is dropped;
 *   - whether `logs` is ever an array - the example sends ONE object; an array of the
 *     same objects is tolerated rather than rejected;
 *   - the meaning of any status code - mapping is ShipmentStatusMapper's, not ours.
 *
 * The body's `signature` / `pdo_signature` / `photo` / `pdo_photo` are delivery
 * MEDIA, never request authentication (that is the `X-Paxel-Signature` header, see
 * infrastructure/providers/paxel-signature.ts). The shipment transition rule is the
 * shared one (domain/shipment-transition.ts); nothing here decides transitions.
 */

/** Bump when a fingerprint/key pre-image changes: old and new must never collide. */
export const PAXEL_WEBHOOK_FINGERPRINT_VERSION = 'v1';

const PAXEL_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;
const MAX_URL_LENGTH = 2048;
const MAX_LOG_ENTRIES = 100;
const MAX_ITEMS = 100;
const MAX_STORED_LOGS = 200;
const MAX_STORED_OBSERVATIONS = 100;

/** Field-length ceilings: generous for real data, bounded against abuse. */
const LIMITS = {
  identifier: 128, // airwaybill_code, invoice_number
  code: 64, // statuses, item codes
  text: 1000, // names, notes, addresses, reasons
} as const;

/** A courier figure: exactly as Paxel sent it, plus its numeric value. No unit implied. */
export interface PaxelNumber {
  raw: string;
  value: number;
}

/** One `logs` entry (location/event detail). */
export interface PaxelLogEntry {
  /** Deterministic identity of this entry - every field it carries. */
  key: string;
  status?: string;
  /** Verbatim courier value; zone undocumented, never converted. */
  createdDatetime?: string;
  note?: string;
  name?: string;
  address?: string;
  district?: string;
  city?: string;
  province?: string;
  latitude?: number;
  longitude?: number;
}

export interface PaxelItem {
  code?: string;
  name?: string;
  category?: string;
  specialInsurance?: boolean;
}

export interface PaxelMedia {
  /** External Paxel-hosted links: stored and linked only, never fetched or proxied. */
  photoUrl?: string;
  signatureUrl?: string;
  pdoPhotoUrl?: string;
  pdoSignatureUrl?: string;
}

export interface PaxelMoney {
  /** Courier information only - never applied to payment or order state. */
  collectMoney?: PaxelNumber;
  billNote?: string;
}

export interface PaxelWebhookPayload {
  airwaybillCode: string;
  latestStatus: string;
  invoiceNumber?: string;
  cancellationReason?: string;
  /** Verbatim courier value; zone undocumented. */
  deliveryDatetime?: string;
  driverName?: string;
  receiverName?: string;
  senderName?: string;
  actualPrice?: PaxelNumber;
  actualWeight?: PaxelNumber;
  media: PaxelMedia;
  money?: PaxelMoney;
  items?: PaxelItem[];
  logs: PaxelLogEntry[];
  /**
   * When this push's status happened: the latest valid `created_datetime` among the
   * log entries whose `status` IS the `latest_status` (verbatim, comparable only with
   * other Paxel log times). Null when no such entry exists.
   */
  eventAt: string | null;
  /** Optional fields present but unusable - dropped by NAME, never stored. */
  dropped: string[];
  /** Deterministic identity of everything usable in this push. */
  fingerprint: string;
}

export type PaxelParseResult =
  | { ok: true; value: PaxelWebhookPayload }
  | { ok: false; reason: string; airwaybillCode?: string };

function sha256(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when the string holds a C0 control character (except TAB, LF, CR) or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

/** A JSON string/number as a trimmed string; undefined for absent/empty/null; null for a wrong type. */
function scalar(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(compact(value)).length > 0 ? compact(value) : undefined;
}

/** True when `raw` is a real calendar date-time in `YYYY-MM-DD HH:MM:SS` (zone-free check only). */
export function isValidPaxelDatetime(raw: string): boolean {
  const m = PAXEL_DATETIME.exec(raw);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/**
 * The two body fields the `X-Paxel-Signature` covers, VERBATIM (untrimmed) - the
 * signature must be checked before anything else in the body is trusted, and over
 * exactly the characters Paxel signed.
 */
export function extractPaxelSignedFields(
  input: unknown,
): { ok: true; airwaybillCode: string; latestStatus: string } | { ok: false; reason: string } {
  if (!isPlainObject(input)) return { ok: false, reason: 'body must be a JSON object' };
  for (const field of ['airwaybill_code', 'latest_status'] as const) {
    const value = input[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return { ok: false, reason: `${field} is required` };
    }
    if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string` };
  }
  return { ok: true, airwaybillCode: input.airwaybill_code as string, latestStatus: input.latest_status as string };
}

export function parsePaxelWebhook(input: unknown): PaxelParseResult {
  if (!isPlainObject(input)) return { ok: false, reason: 'body must be a JSON object' };
  const body = input;
  const dropped: string[] = [];

  // ----- the two required fields (strings: they are signature inputs)
  const required: Record<'airwaybill_code' | 'latest_status', string> = { airwaybill_code: '', latest_status: '' };
  // Correlator for the refusal log only (bounded); never used to look anything up.
  const awb = typeof body.airwaybill_code === 'string' ? body.airwaybill_code.trim().slice(0, LIMITS.identifier) : undefined;
  for (const field of ['airwaybill_code', 'latest_status'] as const) {
    const value = body[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return { ok: false, reason: `${field} is required`, airwaybillCode: awb };
    }
    if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string`, airwaybillCode: awb };
    const trimmed = value.trim();
    if (trimmed.length > (field === 'airwaybill_code' ? LIMITS.identifier : LIMITS.code)) {
      return { ok: false, reason: `${field} is too long`, airwaybillCode: awb };
    }
    if (hasControlCharacter(trimmed)) return { ok: false, reason: `${field} contains control characters`, airwaybillCode: awb };
    required[field] = trimmed;
  }

  // ----- optional fields: unusable values are dropped (by name), never rejected
  const text = (source: Record<string, unknown>, field: string, label: string, limit: number = LIMITS.text): string | undefined => {
    const v = scalar(source[field]);
    if (v === undefined) return undefined;
    if (v === null || v.length > limit || hasControlCharacter(v)) {
      dropped.push(label);
      return undefined;
    }
    return v;
  };
  const number = (source: Record<string, unknown>, field: string, label: string, pattern: RegExp, bound?: number): PaxelNumber | undefined => {
    const v = scalar(source[field]);
    if (v === undefined) return undefined;
    const value = v === null ? NaN : Number(v);
    if (v === null || !pattern.test(v) || !Number.isFinite(value) || (bound !== undefined && Math.abs(value) > bound)) {
      dropped.push(label);
      return undefined;
    }
    return { raw: v, value };
  };
  const media = (field: string): string | undefined => {
    const v = text(body, field, field, MAX_URL_LENGTH);
    if (v === undefined) return undefined;
    const safe = sanitizeMediaUrl(v);
    if (!safe) dropped.push(field);
    return safe ?? undefined;
  };

  // ----- logs: one object in the example; an array of such objects is tolerated
  const logs: PaxelLogEntry[] = [];
  if (body.logs !== undefined && body.logs !== null) {
    const list = Array.isArray(body.logs) ? body.logs : [body.logs];
    const many = Array.isArray(body.logs);
    if (list.length > MAX_LOG_ENTRIES) {
      dropped.push('logs');
    } else {
      list.forEach((item, index) => {
        const label = many ? `logs[${index}]` : 'logs';
        if (!isPlainObject(item)) {
          dropped.push(label);
          return;
        }
        const entry = compact({
          status: text(item, 'status', `${label}.status`, LIMITS.code),
          createdDatetime: text(item, 'created_datetime', `${label}.created_datetime`, LIMITS.code),
          note: text(item, 'note', `${label}.note`),
          name: text(item, 'name', `${label}.name`),
          address: text(item, 'address', `${label}.address`),
          district: text(item, 'district', `${label}.district`),
          city: text(item, 'city', `${label}.city`),
          province: text(item, 'province', `${label}.province`),
          latitude: number(item, 'latitude', `${label}.latitude`, SIGNED_DECIMAL, 90)?.value,
          longitude: number(item, 'longitude', `${label}.longitude`, SIGNED_DECIMAL, 180)?.value,
        });
        if (Object.keys(entry).length === 0) return;
        logs.push({ key: logEntryKey(entry), ...entry });
      });
    }
  }

  // ----- money
  let money: PaxelMoney | undefined;
  if (body.money !== undefined && body.money !== null) {
    if (!isPlainObject(body.money)) {
      dropped.push('money');
    } else {
      money = nonEmpty({
        collectMoney: number(body.money, 'collect_money', 'money.collect_money', NON_NEGATIVE_DECIMAL),
        billNote: text(body.money, 'bill_note', 'money.bill_note'),
      });
    }
  }

  // ----- items
  let items: PaxelItem[] | undefined;
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
      dropped.push('items');
    } else {
      const parsed: PaxelItem[] = [];
      body.items.forEach((item, index) => {
        if (!isPlainObject(item)) {
          dropped.push(`items[${index}]`);
          return;
        }
        const special = item.special_insurance;
        if (special !== undefined && special !== null && typeof special !== 'boolean') dropped.push(`items[${index}].special_insurance`);
        const entry = nonEmpty<PaxelItem>({
          code: text(item, 'code', `items[${index}].code`, LIMITS.code),
          name: text(item, 'name', `items[${index}].name`),
          category: text(item, 'category', `items[${index}].category`),
          specialInsurance: typeof special === 'boolean' ? special : undefined,
        });
        if (entry) parsed.push(entry);
      });
      items = parsed.length ? parsed : undefined;
    }
  }

  const latestStatusKey = required.latest_status.toUpperCase();
  const eventTimes = logs
    .filter((l) => l.status?.toUpperCase() === latestStatusKey && l.createdDatetime && isValidPaxelDatetime(l.createdDatetime))
    .map((l) => l.createdDatetime as string)
    .sort();
  const eventAt = eventTimes.length ? eventTimes[eventTimes.length - 1] : null;

  const value: Omit<PaxelWebhookPayload, 'fingerprint' | 'dropped'> = {
    airwaybillCode: required.airwaybill_code,
    latestStatus: required.latest_status,
    invoiceNumber: text(body, 'invoice_number', 'invoice_number', LIMITS.identifier),
    cancellationReason: text(body, 'cancellation_reason', 'cancellation_reason'),
    deliveryDatetime: text(body, 'delivery_datetime', 'delivery_datetime', LIMITS.code),
    driverName: text(body, 'driver_name', 'driver_name'),
    receiverName: text(body, 'receiver_name', 'receiver_name'),
    senderName: text(body, 'sender_name', 'sender_name'),
    actualPrice: number(body, 'actual_price', 'actual_price', NON_NEGATIVE_DECIMAL),
    actualWeight: number(body, 'actual_weight', 'actual_weight', NON_NEGATIVE_DECIMAL),
    media: compact({
      photoUrl: media('photo'),
      signatureUrl: media('signature'),
      pdoPhotoUrl: media('pdo_photo'),
      pdoSignatureUrl: media('pdo_signature'),
    }),
    money,
    items,
    logs,
    eventAt,
  };

  return {
    ok: true,
    value: {
      ...compact(value),
      media: value.media,
      logs,
      eventAt,
      dropped,
      fingerprint: sha256([`paxel-webhook-${PAXEL_WEBHOOK_FINGERPRINT_VERSION}`, canonicalJson(value)]),
    },
  };
}

/** Identity of one log entry: every field it carries (key order irrelevant). */
export function logEntryKey(entry: Omit<PaxelLogEntry, 'key'>): string {
  return sha256([`paxel-log-${PAXEL_WEBHOOK_FINGERPRINT_VERSION}`, canonicalJson(entry)]);
}

// ------------------------------------------------------ persisted record -----

/** The latest courier-reported figures (never overwritten by an OLDER push). */
export interface PaxelWebhookSnapshot {
  latestStatus: string;
  invoiceNumber?: string;
  cancellationReason?: string;
  deliveryDatetime?: string;
  driverName?: string;
  receiverName?: string;
  senderName?: string;
  /** Courier actuals - Shipment.cost (what the customer was charged) is never replaced. */
  actualPrice?: PaxelNumber;
  actualWeight?: PaxelNumber;
  media?: PaxelMedia;
  money?: PaxelMoney;
  items?: PaxelItem[];
}

/** Every distinct push received, even ones that moved nothing. */
export interface PaxelWebhookObservation {
  fingerprint: string;
  /** Paxel's status code, verbatim. */
  latestStatus: string;
  /** The internal status it maps to; null = undocumented/unmapped (recorded, never applied). */
  mappedStatus: string | null;
  /** Verbatim Paxel log time the push speaks for; null when it carried none. */
  eventAt: string | null;
  /** Our own receipt instant (ISO, our clock). */
  firstReceivedAt: string;
}

/**
 * Shipment.metadata.paxel.webhook - everything Paxel pushed, system-owned and
 * courier-internal: never shown to customers, never overwritten by admin edits.
 * The `X-Paxel-Signature` header is never part of it.
 */
export interface PaxelWebhookRecord {
  version: 1;
  airwaybillCode: string;
  /** Receipt time (ISO, our clock) of the last push that added or changed anything. */
  lastReceivedAt: string;
  /** Latest valid Paxel log time seen (verbatim). */
  lastEventAt: string | null;
  /** Log time (verbatim) / status of the last push that MOVED the shipment. */
  lastAppliedEventAt: string | null;
  lastAppliedStatus: string | null;
  latest: PaxelWebhookSnapshot;
  logs: PaxelLogEntry[];
  observations: PaxelWebhookObservation[];
}

function snapshotOf(payload: PaxelWebhookPayload): PaxelWebhookSnapshot {
  return compact({
    latestStatus: payload.latestStatus,
    invoiceNumber: payload.invoiceNumber,
    cancellationReason: payload.cancellationReason,
    deliveryDatetime: payload.deliveryDatetime,
    driverName: payload.driverName,
    receiverName: payload.receiverName,
    senderName: payload.senderName,
    actualPrice: payload.actualPrice,
    actualWeight: payload.actualWeight,
    media: nonEmpty(payload.media),
    money: payload.money,
    items: payload.items,
  });
}

/** `over` wins field by field; media and money are filled in, not replaced wholesale. */
function overlay(base: PaxelWebhookSnapshot, over: PaxelWebhookSnapshot): PaxelWebhookSnapshot {
  return compact({
    ...base,
    ...over,
    media: nonEmpty({ ...(base.media ?? {}), ...(over.media ?? {}) }),
    money: nonEmpty({ ...(base.money ?? {}), ...(over.money ?? {}) }),
  });
}

const logTime = (l: PaxelLogEntry) => l.createdDatetime ?? '';

/**
 * Merge one push into the stored record. Pure and idempotent: merging the same push
 * twice yields `changed: false` the second time. A push OLDER than what is known
 * (by Paxel log time) still contributes its logs and its observation, and fills in
 * figures not yet known, but never overwrites newer figures.
 */
export function mergePaxelWebhook(
  stored: PaxelWebhookRecord | undefined,
  payload: PaxelWebhookPayload,
  mappedStatus: string | null,
  receivedAt: Date,
): { next: PaxelWebhookRecord; changed: boolean; addedLogs: number } {
  const prev = stored && stored.version === 1 ? stored : undefined;
  const isOlder = Boolean(payload.eventAt && prev?.lastEventAt && payload.eventAt < prev.lastEventAt);
  const incoming = snapshotOf(payload);
  const latest = !prev ? incoming : isOlder ? overlay(incoming, prev.latest) : overlay(prev.latest, incoming);

  const logs = new Map<string, PaxelLogEntry>((prev?.logs ?? []).map((l) => [l.key, l]));
  let addedLogs = 0;
  for (const entry of payload.logs) {
    if (logs.has(entry.key)) continue;
    logs.set(entry.key, entry);
    addedLogs += 1;
  }
  const sortedLogs = [...logs.values()].sort((a, b) => (logTime(a) < logTime(b) ? -1 : logTime(a) > logTime(b) ? 1 : 0)).slice(-MAX_STORED_LOGS);

  const observations = [...(prev?.observations ?? [])];
  if (!observations.some((o) => o.fingerprint === payload.fingerprint)) {
    observations.push({
      fingerprint: payload.fingerprint,
      latestStatus: payload.latestStatus,
      mappedStatus,
      eventAt: payload.eventAt,
      firstReceivedAt: receivedAt.toISOString(),
    });
  }

  const prevLast = prev?.lastEventAt ?? null;
  const lastEventAt = !prevLast ? payload.eventAt : !payload.eventAt ? prevLast : payload.eventAt > prevLast ? payload.eventAt : prevLast;

  const next: PaxelWebhookRecord = {
    version: 1,
    airwaybillCode: payload.airwaybillCode,
    lastReceivedAt: prev?.lastReceivedAt ?? receivedAt.toISOString(),
    lastEventAt,
    lastAppliedEventAt: prev?.lastAppliedEventAt ?? null,
    lastAppliedStatus: prev?.lastAppliedStatus ?? null,
    latest,
    logs: sortedLogs,
    observations: observations.slice(-MAX_STORED_OBSERVATIONS),
  };

  const withoutReceipt = (r: PaxelWebhookRecord | undefined) => (r ? { ...r, lastReceivedAt: undefined } : undefined);
  const changed = canonicalJson(withoutReceipt(stored)) !== canonicalJson(withoutReceipt(next));
  if (changed) next.lastReceivedAt = receivedAt.toISOString();
  return { next, changed, addedLogs };
}
