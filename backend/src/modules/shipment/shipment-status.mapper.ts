import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, ShipmentStatus } from '@prisma/client';

export interface MappedStatus {
  mapped: ShipmentStatus;
  known: boolean;
}

/** Normalize a raw provider status: uppercase, collapse separators to `_`. */
function norm(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

// Provider-specific status dictionaries (keyed by normalized provider status).
/**
 * Paxel's status vocabulary. Every code below is mapped from Paxel's OWN definition,
 * onto the EXISTING internal lifecycle (no new ShipmentStatus values):
 *
 *   Paxel documentation (Webhook > Shipment Status Mapping):
 *     RTP    Shipment successfully created          -> CREATED
 *     COL    Courier has arrived at pickup location -> WAITING_PICKUP
 *     PAPV   Courier has picked up your shipment    -> PICKED_UP
 *     POLXL  Package on Origin Locker               -> IN_TRANSIT
 *     ODLXL  Package on Destination Locker          -> IN_TRANSIT
 *     HAPH   Hold at Paxel Home                     -> IN_TRANSIT
 *     COD    Courier has arrived at destination     -> OUT_FOR_DELIVERY
 *     ODL    On Delivery                            -> OUT_FOR_DELIVERY
 *     PDO    Delivery is Completed                  -> DELIVERED
 *     PRJL   Pickup cancelled by courier            -> FAILED
 *
 *   Why these internal states:
 *     - The locker and Paxel Home states hold the parcel INSIDE Paxel's network after
 *       pickup and before the last mile: IN_TRANSIT. None of them is DELIVERED (only PDO
 *       completes a delivery) and none is OUT_FOR_DELIVERY (the courier is not yet on
 *       the way to the recipient), so no customer is told too early.
 *     - PRJL is FAILED, not CANCELLED: a courier cancelling the PICKUP does not cancel
 *       the customer's order (CANCELLED cascades to the order); FAILED keeps the order
 *       and leaves the shipment re-bookable by an admin.
 *
 *   Deliberately ABSENT, kept AS-IS until Paxel confirms their meaning:
 *     FAILED3PL, ONHOLD3PL
 *   They are not mapped from their literal words; they fall through to UNKNOWN (the
 *   poller) / 'unmapped_status' (the webhook): recorded, never applied.
 *
 * POL, POD and the failure codes below come from the note text Paxel ships with each
 * status in its eCommerce API Postman collection. The generic keys are kept
 * alongside: they cost nothing and cover a provider that starts returning plain words.
 */
const PAXEL: Record<string, ShipmentStatus> = {
  // --- documented Paxel codes ---
  CONFIRMED: ShipmentStatus.CREATED,
  RTP: ShipmentStatus.CREATED, // Paxel doc: "Shipment successfully created"
  COL: ShipmentStatus.WAITING_PICKUP, // Paxel doc: "Courier has arrived at pickup location"
  PAPV: ShipmentStatus.PICKED_UP, // Paxel doc: "Courier has picked up your shipment"
  POLXL: ShipmentStatus.IN_TRANSIT, // Paxel doc: "Package on Origin Locker"
  ODLXL: ShipmentStatus.IN_TRANSIT, // Paxel doc: "Package on Destination Locker"
  HAPH: ShipmentStatus.IN_TRANSIT, // Paxel doc: "Hold at Paxel Home"
  POL: ShipmentStatus.IN_TRANSIT, // "shipment in transit"
  POD: ShipmentStatus.OUT_FOR_DELIVERY, // "on the way to destination"
  COD: ShipmentStatus.OUT_FOR_DELIVERY, // Paxel doc: "Courier has arrived at destination"
  ODL: ShipmentStatus.OUT_FOR_DELIVERY, // Paxel doc: "On Delivery"
  PDO: ShipmentStatus.DELIVERED, // Paxel doc: "Delivery is Completed"
  PRJL: ShipmentStatus.FAILED, // Paxel doc: "Pickup cancelled by courier"
  RAP: ShipmentStatus.FAILED, // failed pickup, sender uncontactable
  UNDLM: ShipmentStatus.FAILED, // undelivered, address not found
  RTN: ShipmentStatus.FAILED, // returning to sender (no RETURNED in the enum)
  // FAILED3PL, ONHOLD3PL: intentionally absent (meaning not confirmed by Paxel).
  // Confirmed against Paxel staging, not inferred from the acronym: POST
  // /shipments/:awb/cancel returned 200 echoing our cancellation_reason, after
  // which GET /shipments/:awb reported latest_status "CCS" carrying that same
  // reason. Until this mapping existed, CCS fell through to UNKNOWN, which the
  // sync service never persists - so a shipment cancelled at Paxel stayed
  // CREATED in our database forever.
  CCS: ShipmentStatus.CANCELLED,

  // --- generic fallbacks, retained ---
  BOOKED: ShipmentStatus.CREATED,
  CREATED: ShipmentStatus.CREATED,
  WAITING_PICKUP: ShipmentStatus.WAITING_PICKUP,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  DELIVERED: ShipmentStatus.DELIVERED,
  FAILED: ShipmentStatus.FAILED,
  CANCELLED: ShipmentStatus.CANCELLED,
  CANCELED: ShipmentStatus.CANCELLED,
};

const JNE: Record<string, ShipmentStatus> = {
  SUCCESS: ShipmentStatus.CREATED,
  MANIFESTED: ShipmentStatus.CREATED,
  RECEIVED_AT_ORIGIN: ShipmentStatus.CREATED,
  WAITING_PICKUP: ShipmentStatus.WAITING_PICKUP,
  PICKED_UP: ShipmentStatus.PICKED_UP,
  RECEIVED_AT_WAREHOUSE: ShipmentStatus.PICKED_UP,
  ON_PROCESS: ShipmentStatus.IN_TRANSIT,
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  TRANSIT: ShipmentStatus.IN_TRANSIT,
  RECEIVED_AT_SORTING: ShipmentStatus.IN_TRANSIT,
  WITH_DELIVERY_COURIER: ShipmentStatus.OUT_FOR_DELIVERY,
  ON_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  DELIVERED: ShipmentStatus.DELIVERED,
  POD: ShipmentStatus.DELIVERED,
  CANCELLED: ShipmentStatus.CANCELLED,
  // KNOWN GAP - the tracking poller cannot tell a failed PICKUP from a failed shipment.
  // The JNE tracking adapter exposes one free-text field, `cnote.pod_status`, and no
  // JNE tracking status vocabulary exists in this codebase (these generic words carry
  // no cited JNE source; the only real sample is 'DELIVERED'). So a pod_status of
  // FAILED / RETURNED / UNDELIVERED stays the terminal FAILED it always was, even though
  // the JNE WEBHOOK records FAILED PICKUP without a transition. Reconciling the two
  // needs JNE's documented pod_status values (or a sandbox capture); inventing a
  // mapping here could either fail a live parcel or hide a real failure.
  // Pinned by test/unit/jne-poller-failure-vocabulary.spec.ts.
  FAILED: ShipmentStatus.FAILED,
  RETURNED: ShipmentStatus.FAILED,
  UNDELIVERED: ShipmentStatus.FAILED,

  // --- JNE Webhook Status V2 summary statuses (documented) ---
  // DELIVERED is shared with the list above.
  SUCCESS_PICKUP: ShipmentStatus.PICKED_UP,
  SHIPPED: ShipmentStatus.IN_TRANSIT, // in JNE's network, not yet delivered
  // No returned state exists; FAILED is the existing precedent for a parcel going back
  // to the sender (Paxel RTN, JNE RETURNED above) - the delivery has definitively failed.
  RETURN_TO_SHIPPER: ShipmentStatus.FAILED,
  // Deliberately ABSENT - both fall through to UNKNOWN, so the shipment keeps its last
  // known state and the JNE webhook records the event instead of guessing:
  //   FAILED PICKUP     an unsuccessful pickup ATTEMPT, not a failed shipment. FAILED is
  //                     terminal (tracking stops; a later SUCCESS PICKUP or DELIVERED could
  //                     never apply) and would tell the customer "gagal dikirim".
  //   SHIPMENT PROBLEM  JNE does not say whether it is terminal; FAILED would end tracking
  //                     and an in-transit state would hide the problem.
};

const DICTIONARIES: Record<string, Record<string, ShipmentStatus>> = { paxel: PAXEL, jne: JNE };

/**
 * Pure provider-status lookup, exported so adapters do not keep a second copy of
 * the vocabulary. A provider that maintained its own switch drifted from this
 * dictionary and silently answered UNKNOWN for statuses that were mapped here.
 * Returns undefined when the status is not recognised; the caller decides what
 * that means (the Nest service logs it, an adapter falls back to UNKNOWN).
 */
export function lookupProviderStatus(provider: string, providerStatus: string): ShipmentStatus | undefined {
  return DICTIONARIES[provider.toLowerCase()]?.[norm(providerStatus)];
}

// Which mapped statuses trigger a customer notification (one per transition).
const NOTIFY_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
]);

// Terminal shipment states — polling stops here.
export const TERMINAL_SHIPMENT_STATUSES = new Set<ShipmentStatus>([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
]);

const STATUS_LABEL: Partial<Record<ShipmentStatus, string>> = {
  [ShipmentStatus.CREATED]: 'telah dibuat',
  [ShipmentStatus.WAITING_PICKUP]: 'menunggu penjemputan kurir',
  [ShipmentStatus.PICKED_UP]: 'telah dijemput kurir',
  [ShipmentStatus.IN_TRANSIT]: 'sedang dalam perjalanan',
  [ShipmentStatus.OUT_FOR_DELIVERY]: 'sedang menuju alamat Anda',
  [ShipmentStatus.DELIVERED]: 'telah sampai di tujuan',
  [ShipmentStatus.CANCELLED]: 'dibatalkan',
  [ShipmentStatus.FAILED]: 'gagal dikirim',
};

/**
 * Maps provider-specific tracking statuses into internal ShipmentStatus, plus the
 * derived order status and notification metadata. Unknown provider statuses map to
 * UNKNOWN and are logged (never silently swallowed).
 */
@Injectable()
export class ShipmentStatusMapper {
  private readonly logger = new Logger('ShipmentStatusMapper');

  map(provider: string, providerStatus: string): MappedStatus {
    const dict = DICTIONARIES[provider.toLowerCase()];
    const mapped = dict?.[norm(providerStatus)];
    if (!mapped) {
      this.logger.warn(
        `Unknown shipment status from provider '${provider}': '${providerStatus}' → UNKNOWN`,
      );
      return { mapped: ShipmentStatus.UNKNOWN, known: false };
    }
    return { mapped, known: true };
  }

  /** Order status implied by a shipment status (null = leave the order unchanged). */
  toOrderStatus(status: ShipmentStatus): OrderStatus | null {
    switch (status) {
      case ShipmentStatus.CREATED:
      case ShipmentStatus.WAITING_PICKUP:
        return OrderStatus.SHIPPED;
      case ShipmentStatus.PICKED_UP:
      case ShipmentStatus.IN_TRANSIT:
      case ShipmentStatus.OUT_FOR_DELIVERY:
        return OrderStatus.DELIVERING;
      case ShipmentStatus.DELIVERED:
        return OrderStatus.DELIVERED;
      case ShipmentStatus.CANCELLED:
        return OrderStatus.CANCELLED;
      default:
        return null;
    }
  }

  shouldNotify(status: ShipmentStatus): boolean {
    return NOTIFY_STATUSES.has(status);
  }

  isTerminal(status: ShipmentStatus): boolean {
    return TERMINAL_SHIPMENT_STATUSES.has(status);
  }

  label(status: ShipmentStatus): string {
    return STATUS_LABEL[status] ?? status;
  }
}
