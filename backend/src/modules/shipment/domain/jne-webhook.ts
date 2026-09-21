import { createHash } from 'crypto';

/**
 * JNE Webhook Status V2 - PURE domain logic (no I/O, no DB, no logging).
 *
 * Everything here follows the JNE V2 webhook documentation and nothing beyond it:
 *   - the six documented SUMMARY statuses (`status`);
 *   - the documented MANDATORY fields;
 *   - delivery-only fields (signature, photo, receiver_name, receiver_relation,
 *     cod_amount) that are only meaningful for DELIVERED;
 *   - `history[].date` in JNE's `YYYY-MM-DD HH:I:S` (PHP notation: 24-hour HH:MM:SS).
 *
 * Confirmed by JNE in writing (beyond the V2 document): `order_id` is the `order_no`
 * we sent at booking; `actual_weight` and `actual_ongkir` are STRINGS; and
 * `history[].date` is GMT+7 (Asia/Jakarta).
 *
 * The documentation does NOT define: a webhook authentication mechanism, the
 * meaning of individual `status_code`s, or the unit of `actual_weight`. Nothing
 * below invents any of them - see the notes at each use. The shipment transition
 * rule itself is shared with the pollers (domain/shipment-transition.ts); nothing
 * here decides transitions.
 */

export const JNE_SUMMARY_STATUSES = [
  'SUCCESS PICKUP',
  'FAILED PICKUP',
  'SHIPPED',
  'DELIVERED',
  'SHIPMENT PROBLEM',
  'RETURN TO SHIPPER',
] as const;
export type JneSummaryStatus = (typeof JNE_SUMMARY_STATUSES)[number];

export const JNE_MANDATORY_FIELDS = [
  'awb',
  'order_id',
  'status',
  'actual_weight',
  'actual_ongkir',
  'service',
  'actual_sender_name',
  'actual_sender_address',
  'goods_desc',
  'origin_code',
  'dest_code',
] as const;

/**
 * JNE summary statuses that are RECORDED but never move the shipment, because the
 * existing ShipmentStatus model has no state that represents them without a guess:
 *   - FAILED PICKUP: an unsuccessful pickup ATTEMPT. The only failure state, FAILED,
 *     is terminal (tracking stops, a later SUCCESS PICKUP or DELIVERED could never
 *     apply, the customer is told "gagal dikirim"), so a retryable attempt must not
 *     become it. The shipment keeps its pre-pickup state and stays tracked.
 *   - SHIPMENT PROBLEM: JNE does not say whether it is terminal.
 * Both are logged for operators. Whether they should also notify anyone, or become
 * a new internal state, is a business decision this code does not make.
 */
export const JNE_RECORD_ONLY_STATUSES: readonly JneSummaryStatus[] = ['FAILED PICKUP', 'SHIPMENT PROBLEM'];

/**
 * `history[].date` time zone: GMT+7 (Asia/Jakarta), as JNE confirmed in writing.
 * Asia/Jakarta has no daylight saving, so the offset is a fixed +07:00. Each date is
 * kept VERBATIM (identity, ordering: zero-padded in one zone, the format sorts
 * chronologically) and ALSO converted once, explicitly, to the instant it denotes
 * (`at`, ISO-8601 UTC) - see jneDateToInstant(). Nothing adds hours by hand, and the
 * process time zone is irrelevant. ShipmentHistory.changedAt stays OUR receipt time.
 */
export const JNE_HISTORY_UTC_OFFSET = '+07:00';

const JNE_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const MAX_HISTORY_ENTRIES = 500;
const MAX_STORED_EVENTS = 500;
const MAX_STORED_SUMMARIES = 100;
const MAX_URL_LENGTH = 2048;

/** Field-length ceilings: generous for real data, bounded against abuse. */
const LIMITS = {
  identifier: 64, // awb, order_id
  code: 64, // origin/dest/city/location/status codes, service
  text: 1000, // names, addresses, goods description, descriptions
} as const;

/** Bump when a fingerprint pre-image changes: old and new must never collide. */
export const JNE_FINGERPRINT_VERSION = 'v1';

export interface JneNumber {
  /** Exactly as JNE sent it (trimmed). */
  raw: string;
  value: number;
}

export interface JneHistoryEntry {
  /** Deterministic identity of this history event - see historyEntryKey(). */
  key: string;
  /** Verbatim `YYYY-MM-DD HH:MM:SS` as JNE sent it (GMT+7 wall clock; sortable). */
  date: string;
  /** The instant `date` denotes, as ISO-8601 UTC (`date` read as GMT+7). */
  at: string;
  status: string;
  statusCode: string;
  statusDesc: string;
  locationCode: string;
}

export interface JneWebhookPayload {
  awb: string;
  orderId: string;
  status: JneSummaryStatus;
  actualWeight: JneNumber;
  actualOngkir: JneNumber;
  service: string;
  senderName: string;
  senderAddress: string;
  goodsDesc: string;
  originCode: string;
  destCode: string;
  receiverAddress?: string;
  receiverCityName?: string;
  receiverCityCode?: string;
  latitude?: number;
  longitude?: number;
  /** Only populated for DELIVERED - the documented delivery-only fields. */
  delivery?: {
    receiverName?: string;
    receiverRelation?: string;
    signatureUrl?: string;
    photoUrl?: string;
    codAmount?: JneNumber;
  };
  /** Deduplicated, chronological. */
  history: JneHistoryEntry[];
  /**
   * The latest history date (verbatim JNE string) = the time this webhook speaks for;
   * null when it carried no history. Compared with other JNE dates.
   */
  eventAt: string | null;
  /** `eventAt` as the instant it denotes (ISO-8601 UTC); null when eventAt is null. */
  eventInstant: string | null;
  /** Optional fields present but unusable (bad URL / number) - dropped, never stored. */
  dropped: string[];
  /** Deterministic identity of the whole webhook, for logs and tracing retries. */
  fingerprint: string;
}

export type JneParseResult =
  | { ok: true; value: JneWebhookPayload }
  | { ok: false; reason: string; awb?: string; orderId?: string };

function sha256(parts: unknown[]): string {
  // JSON-array encoding, not a delimiter join: a value containing the delimiter
  // could otherwise collide with a different split of the same characters.
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** True when `raw` is a real calendar date-time in JNE's `YYYY-MM-DD HH:MM:SS`. */
export function isValidJneDate(raw: string): boolean {
  const m = JNE_DATE.exec(raw);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  // Zone-free calendar check: rejects dates Date.UTC would roll over (2026-02-30 → March 2).
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/**
 * The instant a JNE `history[].date` denotes. JNE confirmed the value is GMT+7, so
 * the wall-clock fields are read with an explicit +07:00 offset (never the process's
 * local zone, never UTC). Example: "2026-09-12 09:00:00" -> 2026-09-12T02:00:00.000Z.
 * Returns null for anything that is not a valid JNE date.
 */
export function jneDateToInstant(raw: string): Date | null {
  if (!isValidJneDate(raw)) return null;
  const instant = new Date(`${raw.replace(' ', 'T')}${JNE_HISTORY_UTC_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** jneDateToInstant as ISO-8601 UTC (the stored form). Only for already-validated dates. */
function jneInstantIso(raw: string): string {
  return (jneDateToInstant(raw) as Date).toISOString();
}

/** Chronological comparison of two JNE dates (same GMT+7 zone, sortable format). */
export function compareJneDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Identity of one history event: every field JNE gives it. `status_code` alone is
 * NOT an identity - the documentation's own example repeats a code across entries -
 * so two entries are "the same event" only when date, status, code, description and
 * location all match.
 */
export function historyEntryKey(e: Pick<JneHistoryEntry, 'date' | 'status' | 'statusCode' | 'statusDesc' | 'locationCode'>): string {
  return sha256([`jne-history-${JNE_FINGERPRINT_VERSION}`, e.date, e.status, e.statusCode, e.statusDesc, e.locationCode]);
}

/**
 * External media URL (delivery signature image / photo). JNE-hosted content that we
 * only STORE AND LINK - never fetch, never proxy. Allowed: absolute http(s), no
 * embedded credentials, bounded length. Anything else is dropped.
 */
export function sanitizeMediaUrl(raw: string): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

// ---------------------------------------------------------------- parsing ----

/** True when the string holds a C0 control character (except TAB, LF, CR) or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

/** A JSON string/number as a trimmed string; undefined for absent/empty/null. */
function scalar(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null; // wrong type
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function decimal(raw: string): JneNumber | null {
  if (!DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? { raw, value } : null;
}

function coordinate(raw: string | undefined, bound: number): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Math.abs(value) <= bound ? value : null;
}

function fail(reason: string, body: Record<string, unknown>): JneParseResult {
  const awb = typeof body.awb === 'string' ? body.awb.trim().slice(0, LIMITS.identifier) : undefined;
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim().slice(0, LIMITS.identifier) : undefined;
  return { ok: false, reason, awb, orderId };
}

/**
 * Validate and normalize a JNE V2 webhook body. Unknown extra fields are tolerated
 * (JNE may add some) but never stored. Mandatory fields and the history format are
 * strict; optional fields that arrive unusable are dropped and named in `dropped`,
 * because rejecting a real DELIVERED push over a malformed photo URL would only make
 * JNE retry it forever.
 */
export function parseJneWebhook(input: unknown): JneParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const body = input as Record<string, unknown>;

  const mandatory: Record<string, string> = {};
  for (const field of JNE_MANDATORY_FIELDS) {
    const value = scalar(body[field]);
    if (value === null) return fail(`${field} must be a string`, body);
    if (value === undefined) return fail(`${field} is required`, body);
    const limit = field === 'awb' || field === 'order_id' ? LIMITS.identifier : field.endsWith('_code') || field === 'service' || field === 'status' ? LIMITS.code : LIMITS.text;
    if (value.length > limit) return fail(`${field} is too long`, body);
    if (hasControlCharacter(value)) return fail(`${field} contains control characters`, body);
    mandatory[field] = value;
  }

  const status = mandatory.status.toUpperCase().replace(/\s+/g, ' ') as JneSummaryStatus;
  if (!JNE_SUMMARY_STATUSES.includes(status)) {
    return fail(`status must be one of: ${JNE_SUMMARY_STATUSES.join(', ')}`, body);
  }

  const actualWeight = decimal(mandatory.actual_weight);
  if (!actualWeight) return fail('actual_weight must be a non-negative number', body);
  const actualOngkir = decimal(mandatory.actual_ongkir);
  if (!actualOngkir) return fail('actual_ongkir must be a non-negative number', body);

  // ----- history
  let history: JneHistoryEntry[] = [];
  if (body.history !== undefined && body.history !== null) {
    if (!Array.isArray(body.history)) return fail('history must be an array', body);
    if (body.history.length > MAX_HISTORY_ENTRIES) return fail('history has too many entries', body);
    const seen = new Map<string, JneHistoryEntry>();
    for (const [index, item] of body.history.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(`history[${index}] must be an object`, body);
      const entry = item as Record<string, unknown>;
      const date = scalar(entry.date);
      if (typeof date !== 'string') return fail(`history[${index}].date is required`, body);
      if (!isValidJneDate(date)) return fail(`history[${index}].date must be YYYY-MM-DD HH:MM:SS`, body);
      const text: Record<string, string> = {};
      for (const f of ['status', 'status_code', 'status_desc', 'location_code'] as const) {
        const v = scalar(entry[f]);
        if (v === null) return fail(`history[${index}].${f} must be a string`, body);
        if ((v ?? '').length > (f === 'status_desc' || f === 'status' ? LIMITS.text : LIMITS.code)) return fail(`history[${index}].${f} is too long`, body);
        text[f] = v ?? '';
      }
      const fields = { date, status: text.status, statusCode: text.status_code, statusDesc: text.status_desc, locationCode: text.location_code };
      const key = historyEntryKey(fields);
      if (!seen.has(key)) seen.set(key, { key, ...fields, at: jneInstantIso(date) });
    }
    // Chronological by the verbatim JNE date; equal dates keep JNE's order (stable sort).
    history = [...seen.values()].sort((a, b) => compareJneDates(a.date, b.date));
  }
  const eventAt = history.length ? history[history.length - 1].date : null;

  // ----- optional fields (dropped, not rejected, when unusable)
  const dropped: string[] = [];
  const optionalText = (field: string, limit: number = LIMITS.text): string | undefined => {
    const v = scalar(body[field]);
    if (v === undefined) return undefined;
    if (v === null || v.length > limit || hasControlCharacter(v)) {
      dropped.push(field);
      return undefined;
    }
    return v;
  };

  const latitude = coordinate(optionalText('latitude', LIMITS.code), 90);
  if (latitude === null) dropped.push('latitude');
  const longitude = coordinate(optionalText('longitude', LIMITS.code), 180);
  if (longitude === null) dropped.push('longitude');

  let delivery: JneWebhookPayload['delivery'];
  if (status === 'DELIVERED') {
    const media = (field: string): string | undefined => {
      const v = optionalText(field, MAX_URL_LENGTH);
      if (v === undefined) return undefined;
      const safe = sanitizeMediaUrl(v);
      if (!safe) dropped.push(field);
      return safe ?? undefined;
    };
    const codRaw = optionalText('cod_amount', LIMITS.code);
    const codAmount = codRaw === undefined ? undefined : decimal(codRaw) ?? undefined;
    if (codRaw !== undefined && !codAmount) dropped.push('cod_amount');
    delivery = {
      receiverName: optionalText('receiver_name'),
      receiverRelation: optionalText('receiver_relation', LIMITS.code),
      signatureUrl: media('signature'),
      photoUrl: media('photo'),
      codAmount,
    };
  }
  // For every other status the delivery-only fields are ignored: the documentation
  // defines them for DELIVERED only, so a value elsewhere carries no meaning to store.

  const value: JneWebhookPayload = {
    awb: mandatory.awb,
    orderId: mandatory.order_id,
    status,
    actualWeight,
    actualOngkir,
    service: mandatory.service,
    senderName: mandatory.actual_sender_name,
    senderAddress: mandatory.actual_sender_address,
    goodsDesc: mandatory.goods_desc,
    originCode: mandatory.origin_code,
    destCode: mandatory.dest_code,
    receiverAddress: optionalText('actual_receiver_address'),
    receiverCityName: optionalText('actual_receiver_city_name', LIMITS.code),
    receiverCityCode: optionalText('actual_receiver_city_code', LIMITS.code),
    latitude: latitude ?? undefined,
    longitude: longitude ?? undefined,
    delivery,
    history,
    eventAt,
    eventInstant: eventAt ? jneInstantIso(eventAt) : null,
    dropped,
    fingerprint: sha256([
      `jne-webhook-${JNE_FINGERPRINT_VERSION}`,
      mandatory.awb,
      mandatory.order_id,
      status,
      actualWeight.raw,
      actualOngkir.raw,
      history.map((h) => h.key),
    ]),
  };
  return { ok: true, value };
}

// ------------------------------------------------------ persisted record -----

/** One stored JNE history event (Shipment.metadata.jne.webhook.events[]). */
export interface JneStoredEvent {
  key: string;
  /** Verbatim JNE date (GMT+7 wall clock). */
  date: string;
  /** The instant `date` denotes (ISO-8601 UTC), derived from `date` read as GMT+7. */
  at?: string;
  status: string;
  statusCode: string;
  statusDesc: string;
  locationCode: string;
}

/** Every distinct summary status received, even ones that moved nothing. */
export interface JneStoredSummary {
  status: string;
  /** Latest history date of that webhook (verbatim JNE); null when it carried no history. */
  eventAt: string | null;
  /** Our own receipt instant (ISO, our clock). */
  firstReceivedAt: string;
}

/**
 * Shipment.metadata.jne.webhook - everything JNE reported, kept separate from our
 * own figures. In particular `actual.ongkir` is the COURIER's reported cost and
 * never replaces Shipment.cost (the shipping price quoted and charged to the
 * customer).
 */
export interface JneWebhookRecord {
  /** 2: JNE dates stored verbatim (v1 held WIB-converted instants; never released). */
  version: 2;
  /** Receipt time (ISO, our clock) of the last webhook that added or changed anything. */
  lastReceivedAt: string;
  /** Latest history date seen from any webhook (verbatim JNE). */
  lastEventAt: string | null;
  /** History date (verbatim JNE) / status of the last webhook that MOVED the shipment. */
  lastAppliedEventAt: string | null;
  lastAppliedStatus: string | null;
  actual: { weight: number; weightRaw: string; ongkir: number; ongkirRaw: string; service: string };
  route: {
    originCode: string;
    destCode: string;
    senderName: string;
    senderAddress: string;
    goodsDesc: string;
    receiverAddress?: string;
    receiverCityName?: string;
    receiverCityCode?: string;
    latitude?: number;
    longitude?: number;
  };
  delivery?: {
    receiverName?: string;
    receiverRelation?: string;
    /** External JNE-hosted URLs: stored and linked only, never fetched or proxied. */
    signatureUrl?: string;
    photoUrl?: string;
    /** Courier information only - never applied to payment/order state. */
    codAmount?: number;
    codAmountRaw?: string;
  };
  summaries: JneStoredSummary[];
  events: JneStoredEvent[];
}

/** Stable JSON (sorted keys, undefined dropped) - JSONB does not keep key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Drop undefined keys so the stored JSON and the comparison agree. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Merge one webhook into the stored record. Pure: returns the next record and
 * whether anything new was learned. Idempotent by construction - merging the same
 * payload twice yields `changed: false` on the second pass.
 *
 * A webhook OLDER than what is already known still contributes its history events
 * and its summary line (nothing is lost), but it does not overwrite the "latest"
 * courier figures (actual weight/ongkir, route) with older ones.
 */
/**
 * A stored record in the current shape. A v1 record (never released) keeps its events
 * and figures - every event also carries the verbatim JNE `date` - but its own time
 * fields are discarded rather than compared with verbatim dates; each event's `at`
 * is re-derived from the verbatim date (GMT+7) instead of trusting the stored one.
 */
export function currentJneRecord(stored: JneWebhookRecord | undefined): JneWebhookRecord | undefined {
  if (!stored) return undefined;
  if ((stored.version as number) === 2) return stored;
  const events = (stored.events ?? []).map(({ key, date, status, statusCode, statusDesc, locationCode }) => ({
    key, date, at: jneDateToInstant(date)?.toISOString(), status, statusCode, statusDesc, locationCode,
  }));
  const dates = events.map((e) => e.date).sort(compareJneDates);
  return {
    ...stored,
    version: 2,
    events,
    lastEventAt: dates.length ? dates[dates.length - 1] : null,
    lastAppliedEventAt: null,
    summaries: (stored.summaries ?? []).map((sm) => ({ ...sm, eventAt: null })),
  };
}

export function mergeJneWebhook(
  stored: JneWebhookRecord | undefined,
  payload: JneWebhookPayload,
  receivedAt: Date,
): { next: JneWebhookRecord; addedEvents: number; changed: boolean } {
  const prev = currentJneRecord(stored);
  const eventAtIso = payload.eventAt;
  const prevLastEvent = prev?.lastEventAt ?? null;
  const isOlder = Boolean(eventAtIso && prevLastEvent && compareJneDates(eventAtIso, prevLastEvent) < 0);

  const events = new Map<string, JneStoredEvent>((prev?.events ?? []).map((e) => [e.key, e]));
  let addedEvents = 0;
  for (const h of payload.history) {
    if (events.has(h.key)) continue;
    events.set(h.key, {
      key: h.key,
      date: h.date,
      at: h.at,
      status: h.status,
      statusCode: h.statusCode,
      statusDesc: h.statusDesc,
      locationCode: h.locationCode,
    });
    addedEvents += 1;
  }
  // Every stored event carries its instant; one stored before JNE confirmed GMT+7 gets
  // it derived from its verbatim date (the one-time addition is persisted as a change).
  const sortedEvents = [...events.values()]
    .map((e) => (e.at ? e : compact({ ...e, at: jneDateToInstant(e.date)?.toISOString() })))
    .sort((a, b) => compareJneDates(a.date, b.date))
    .slice(-MAX_STORED_EVENTS);

  const summaries = [...(prev?.summaries ?? [])];
  if (!summaries.some((s) => s.status === payload.status && s.eventAt === eventAtIso)) {
    summaries.push({ status: payload.status, eventAt: eventAtIso, firstReceivedAt: receivedAt.toISOString() });
  }

  const latest = {
    actual: {
      weight: payload.actualWeight.value,
      weightRaw: payload.actualWeight.raw,
      ongkir: payload.actualOngkir.value,
      ongkirRaw: payload.actualOngkir.raw,
      service: payload.service,
    },
    route: compact({
      originCode: payload.originCode,
      destCode: payload.destCode,
      senderName: payload.senderName,
      senderAddress: payload.senderAddress,
      goodsDesc: payload.goodsDesc,
      receiverAddress: payload.receiverAddress,
      receiverCityName: payload.receiverCityName,
      receiverCityCode: payload.receiverCityCode,
      latitude: payload.latitude,
      longitude: payload.longitude,
    }),
  };

  // Delivery details: keep what is known, fill in newly supplied values.
  let delivery = prev?.delivery;
  if (payload.delivery) {
    delivery = compact({
      ...(prev?.delivery ?? {}),
      ...compact({
        receiverName: payload.delivery.receiverName,
        receiverRelation: payload.delivery.receiverRelation,
        signatureUrl: payload.delivery.signatureUrl,
        photoUrl: payload.delivery.photoUrl,
        codAmount: payload.delivery.codAmount?.value,
        codAmountRaw: payload.delivery.codAmount?.raw,
      }),
    });
    if (Object.keys(delivery).length === 0) delivery = prev?.delivery;
  }

  const lastEventAt = !prevLastEvent ? eventAtIso : !eventAtIso ? prevLastEvent : compareJneDates(eventAtIso, prevLastEvent) > 0 ? eventAtIso : prevLastEvent;

  const next: JneWebhookRecord = compact({
    version: 2 as const,
    lastReceivedAt: prev?.lastReceivedAt ?? receivedAt.toISOString(),
    lastEventAt,
    lastAppliedEventAt: prev?.lastAppliedEventAt ?? null,
    lastAppliedStatus: prev?.lastAppliedStatus ?? null,
    actual: prev && isOlder ? prev.actual : latest.actual,
    route: prev && isOlder ? prev.route : latest.route,
    delivery,
    summaries: summaries.slice(-MAX_STORED_SUMMARIES),
    events: sortedEvents,
  });

  const withoutReceipt = (r: JneWebhookRecord | undefined) => (r ? { ...r, lastReceivedAt: undefined } : undefined);
  // Compared with what is STORED: upgrading a v1 record is itself a change to persist.
  const changed = canonicalJson(withoutReceipt(stored)) !== canonicalJson(withoutReceipt(next));
  if (changed) next.lastReceivedAt = receivedAt.toISOString();
  return { next, addedEvents, changed };
}
