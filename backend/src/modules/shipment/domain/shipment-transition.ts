import { ShipmentStatus } from '@prisma/client';
import { TERMINAL_SHIPMENT_STATUSES } from '../shipment-status.mapper';

/**
 * THE shipment transition rule for courier-reported statuses - one rule, used by
 * every courier path: the tracking pollers, the JNE webhook, and (defensively) the
 * shared transition step ShipmentSyncService.applyTransitionInTx. It is a guard over
 * the existing ShipmentStatus model, not a second state machine: it only answers
 * "may this courier observation move the shipment?".
 *
 *   - Terminal states (DELIVERED / FAILED / CANCELLED - the set the poller already
 *     stops at) never change.
 *   - Lifecycle progress only moves forward: CREATED < WAITING_PICKUP < PICKED_UP <
 *     IN_TRANSIT < OUT_FOR_DELIVERY < DELIVERED. A stale answer (IN_TRANSIT → PICKED_UP)
 *     never moves a shipment backwards.
 *   - FAILED and CANCELLED interrupt the lifecycle and may follow any non-terminal
 *     state - unless the observation is provably older than the one that last moved
 *     the shipment.
 *
 * Event times are OPTIONAL and compared only with each other: pass timestamps from
 * ONE source in ONE sortable format (e.g. JNE's `YYYY-MM-DD HH:MM:SS`, whose zone is
 * undocumented but shared by all its events). The pollers have no event time and
 * pass null; the rule then relies on lifecycle order alone.
 */

/** Forward order of the delivery lifecycle. FAILED / CANCELLED sit outside it. */
const PROGRESS_RANK: Partial<Record<ShipmentStatus, number>> = {
  [ShipmentStatus.PENDING]: 0,
  [ShipmentStatus.RATE_SELECTED]: 0,
  [ShipmentStatus.UNKNOWN]: 0,
  [ShipmentStatus.CREATED]: 1,
  [ShipmentStatus.WAITING_PICKUP]: 2,
  [ShipmentStatus.PICKED_UP]: 3,
  [ShipmentStatus.IN_TRANSIT]: 4,
  [ShipmentStatus.OUT_FOR_DELIVERY]: 5,
  [ShipmentStatus.DELIVERED]: 6,
};

/** States that interrupt the lifecycle rather than advance it. */
const INTERRUPTIONS = new Set<ShipmentStatus>([ShipmentStatus.FAILED, ShipmentStatus.CANCELLED]);

export type ShipmentTransitionRejection =
  | 'unmapped_status' // the courier status has no internal state (recorded only)
  | 'terminal' // the shipment is already DELIVERED / FAILED / CANCELLED
  | 'unchanged' // already in the target state
  | 'stale' // older than the event that last moved this shipment
  | 'would_regress' // the target is behind the current lifecycle position
  | 'undated_failure'; // an undated interruption after a dated transition

export type ShipmentTransitionDecision = { apply: true } | { apply: false; reason: ShipmentTransitionRejection };

export function decideShipmentTransition(input: {
  current: ShipmentStatus;
  target: ShipmentStatus | undefined;
  /** When the observation happened (same source/format as lastAppliedEventTime), or null. */
  eventTime?: string | null;
  /** When the observation that last moved this shipment happened, or null. */
  lastAppliedEventTime?: string | null;
}): ShipmentTransitionDecision {
  const { current, target } = input;
  const eventTime = input.eventTime ?? null;
  const lastApplied = input.lastAppliedEventTime ?? null;

  if (!target || target === ShipmentStatus.UNKNOWN) return { apply: false, reason: 'unmapped_status' };
  if (TERMINAL_SHIPMENT_STATUSES.has(current)) return { apply: false, reason: 'terminal' };
  if (target === current) return { apply: false, reason: 'unchanged' };
  if (eventTime && lastApplied && eventTime < lastApplied) return { apply: false, reason: 'stale' };

  if (INTERRUPTIONS.has(target)) {
    // Without a time, an interruption cannot be shown to be newer than a dated move.
    if (!eventTime && lastApplied) return { apply: false, reason: 'undated_failure' };
    return { apply: true };
  }

  const from = PROGRESS_RANK[current] ?? 0;
  const to = PROGRESS_RANK[target];
  if (to === undefined || to <= from) return { apply: false, reason: 'would_regress' };
  return { apply: true };
}
