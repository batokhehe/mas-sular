import { Prisma, ShipmentStatus } from '@prisma/client';
import type { JneWebhookRecord } from './domain/jne-webhook';
import type { PaxelWebhookRecord } from './domain/paxel-webhook';
import type { ShipmentTransitionRejection } from './domain/shipment-transition';

/**
 * Typed accessors for `Shipment.metadata`.
 *
 * The admin-selected pickup time lives here rather than in a new column: it is
 * provider-specific (only Paxel requires it) and adding a column for one
 * courier's field would push provider detail into the shared schema. Keeping
 * the shape in one module is what stops `metadata` from degenerating into
 * ad-hoc string keys spread across services.
 *
 * `pickupDatetime` is stored as ISO-8601 — the exact instant the admin chose.
 * The provider formats it for its own wire contract; nothing else reinterprets
 * it, and it is never derived from the clock.
 */

export interface PaxelShipmentMetadata {
  /** ISO-8601. The admin's choice, verbatim. */
  pickupDatetime?: string;
  /**
   * Everything Paxel pushed through its webhook (status observations, logs, actual
   * price/weight, delivery media links, money). Courier-internal and system-owned:
   * Shipment.cost stays the shipping price the customer was charged.
   */
  webhook?: PaxelWebhookRecord;
}

/**
 * JNE's pickup slot (P1 #13). JNE's booking API has no pickup field, so this is
 * the shop-wide slot recorded for operations only - never sent to JNE and never
 * a condition of its booking. Namespaced like Paxel's so neither can overwrite
 * the other.
 */
export interface JneShipmentMetadata {
  /** ISO-8601. Resolved from the shared pickup rule at booking time. */
  pickupDatetime?: string;
  /**
   * Everything JNE pushed through Webhook Status V2 (history, actual weight/ongkir,
   * delivery details). Courier-reported data, kept apart from our own figures:
   * Shipment.cost stays the shipping price the customer was charged.
   */
  webhook?: JneWebhookRecord;
}

/** Couriers that carry a pickup slot in metadata, each in its own namespace. */
export type PickupCourier = 'paxel' | 'jne';

/**
 * A courier status the tracking poller observed but the shared transition rule
 * refused to apply (stale / backwards / out of a terminal state). Kept so the
 * observation is not lost - never applied, never shown to customers.
 */
export interface TrackingObservation {
  source: 'poll';
  provider: string;
  /** The courier's own status word, verbatim. */
  providerStatus: string;
  /** What that status maps to internally. */
  mappedStatus: ShipmentStatus;
  /** The shipment's status when it was observed. */
  shipmentStatus: ShipmentStatus;
  reason: ShipmentTransitionRejection;
  /** First time this exact observation was seen (ISO, our clock). */
  firstSeenAt: string;
}

/** System-owned tracking diagnostics. */
export interface TrackingMetadata {
  rejected?: TrackingObservation[];
}

export interface ShipmentMetadata {
  paxel?: PaxelShipmentMetadata;
  jne?: JneShipmentMetadata;
  /** Failure diagnostics written by createForOrderSafe. */
  error?: string;
  failedAt?: string;
  /** Written by the tracking pollers only (see TrackingObservation). */
  tracking?: TrackingMetadata;
}

/**
 * Metadata paths owned by the system, not by operators: the courier webhook records
 * (what JNE / Paxel reported) and the pollers' rejected observations. An admin
 * metadata edit can never overwrite or delete them.
 */
const SYSTEM_OWNED_PATHS: ReadonlyArray<readonly string[]> = [['jne', 'webhook'], ['paxel', 'webhook'], ['tracking']];

/** Narrow the loosely-typed Json column without throwing on legacy shapes. */
export function readShipmentMetadata(value: Prisma.JsonValue | null | undefined): ShipmentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ShipmentMetadata;
}

/**
 * The recorded pickup instant for `courier`, or undefined when none exists yet.
 * Defaults to Paxel, whose slot is the one its booking depends on.
 */
export function readPickupDatetime(
  value: Prisma.JsonValue | null | undefined,
  courier: PickupCourier = 'paxel',
): string | undefined {
  const pickup = readShipmentMetadata(value)[courier]?.pickupDatetime;
  return pickup && pickup.trim() ? pickup : undefined;
}

/**
 * Merge a pickup time into existing metadata. Merging rather than replacing so a
 * later booking attempt does not erase the failure diagnostics from an earlier
 * one, which is the only record of why a shipment is stuck.
 */
export function withPickupDatetime(
  existing: Prisma.JsonValue | null | undefined,
  pickupDatetimeIso: string,
  courier: PickupCourier = 'paxel',
): Prisma.InputJsonValue {
  const current = readShipmentMetadata(existing);
  return {
    ...current,
    [courier]: { ...(current[courier] ?? {}), pickupDatetime: pickupDatetimeIso },
  } as Prisma.InputJsonValue;
}

/** The stored JNE webhook record, or undefined when JNE has not pushed yet. */
export function readJneWebhook(value: Prisma.JsonValue | null | undefined): JneWebhookRecord | undefined {
  const record = readShipmentMetadata(value).jne?.webhook;
  return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
}

/**
 * Merge the JNE webhook record into existing metadata, preserving every other key
 * (JNE's pickup slot, Paxel's namespace, booking failure diagnostics).
 */
export function withJneWebhook(existing: Prisma.JsonValue | null | undefined, record: JneWebhookRecord): Prisma.InputJsonValue {
  const current = readShipmentMetadata(existing);
  return JSON.parse(JSON.stringify({ ...current, jne: { ...(current.jne ?? {}), webhook: record } })) as Prisma.InputJsonValue;
}

/** The stored Paxel webhook record, or undefined when Paxel has not pushed yet. */
export function readPaxelWebhook(value: Prisma.JsonValue | null | undefined): PaxelWebhookRecord | undefined {
  const record = readShipmentMetadata(value).paxel?.webhook;
  return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
}

/**
 * Merge the Paxel webhook record into existing metadata, preserving every other key
 * (Paxel's pickup slot, the JNE namespace, booking failure diagnostics).
 */
export function withPaxelWebhook(existing: Prisma.JsonValue | null | undefined, record: PaxelWebhookRecord): Prisma.InputJsonValue {
  const current = readShipmentMetadata(existing);
  return JSON.parse(JSON.stringify({ ...current, paxel: { ...(current.paxel ?? {}), webhook: record } })) as Prisma.InputJsonValue;
}

/**
 * Metadata as a CUSTOMER may see it: the courier-internal webhook records (JNE and
 * Paxel: courier-reported costs, receiver/driver details, media links, money) and
 * the pollers' diagnostics are removed.
 */
export function withoutCourierInternals(value: Prisma.JsonValue | null | undefined): Prisma.JsonValue | null {
  if (value === null || value === undefined) return null;
  const current = readShipmentMetadata(value);
  if (!current.jne?.webhook && !current.paxel?.webhook && !current.tracking) return value;
  const rest: Record<string, unknown> = { ...current };
  delete rest.tracking;
  for (const courier of ['jne', 'paxel'] as const) {
    const namespace = current[courier];
    if (!namespace?.webhook) continue;
    const { webhook: _internal, ...kept } = namespace;
    if (Object.keys(kept).length === 0) delete rest[courier];
    else rest[courier] = kept;
  }
  return rest as Prisma.JsonValue;
}

const MAX_TRACKING_OBSERVATIONS = 50;

/**
 * Record a rejected poller observation. Deduplicated on everything but the time, so
 * a stale answer the poller keeps receiving (the tracking cache holds it for up to
 * two hours) is written once, not on every tick. Returns `added: false` when it was
 * already recorded - the caller then writes nothing.
 */
export function withTrackingObservation(
  existing: Prisma.JsonValue | null | undefined,
  observation: Omit<TrackingObservation, 'firstSeenAt'>,
  seenAt: Date,
): { next: Prisma.InputJsonValue; added: boolean } {
  const current = readShipmentMetadata(existing);
  const rejected = current.tracking?.rejected ?? [];
  const same = (o: TrackingObservation) =>
    o.source === observation.source &&
    o.provider === observation.provider &&
    o.providerStatus === observation.providerStatus &&
    o.mappedStatus === observation.mappedStatus &&
    o.shipmentStatus === observation.shipmentStatus &&
    o.reason === observation.reason;
  if (rejected.some(same)) return { next: current as Prisma.InputJsonValue, added: false };
  const next = {
    ...current,
    tracking: {
      ...(current.tracking ?? {}),
      rejected: [...rejected, { ...observation, firstSeenAt: seenAt.toISOString() }].slice(-MAX_TRACKING_OBSERVATIONS),
    },
  };
  return { next: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue, added: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key] as Record<string, unknown>, value) : value;
  }
  return out;
}

/**
 * An admin metadata edit, MERGED into what is stored - never a wholesale replace.
 *
 *   - Objects merge recursively, so `{ jne: { pickupDatetime } }` updates that one
 *     field and keeps `jne.webhook`; other namespaces (paxel, error diagnostics, ...)
 *     are untouched unless the edit names them. Arrays and scalars in the edit
 *     replace the stored value; `null` stores null.
 *   - System-owned paths (the JNE webhook record, the pollers' observations) are
 *     never taken from the edit: they always keep their stored value.
 */
export function mergeAdminShipmentMetadata(
  existing: Prisma.JsonValue | null | undefined,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  const current = readShipmentMetadata(existing) as Record<string, unknown>;
  const edit = JSON.parse(JSON.stringify(patch ?? {})) as Record<string, unknown>;
  for (const path of SYSTEM_OWNED_PATHS) {
    const parent = path.slice(0, -1).reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), edit);
    if (isPlainObject(parent)) delete parent[path[path.length - 1]];
  }
  const merged = deepMerge(current, edit);
  for (const path of SYSTEM_OWNED_PATHS) {
    // Restore the stored system value exactly (or keep it absent if there was none).
    const stored = path.reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), current);
    if (stored === undefined) continue;
    let node = merged;
    for (const key of path.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = stored;
  }
  return JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue;
}
