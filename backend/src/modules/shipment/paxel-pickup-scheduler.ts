import { Inject, Injectable } from '@nestjs/common';
import { resolvePickupSchedule } from '../shipping/pickup-schedule';
import { PermanentError } from '../shipping/domain/shipping-errors';
import { PickupPolicy, pickupPolicyOf, SHIPPING_CONFIG, ShippingConfig } from '../shipping/shipping.config';

/**
 * The automatic Paxel pickup schedule (PAXELBOX-61AG.3.32), now the approved
 * shop-wide policy (Phase 2): cut-off 15:00 WIB - 15:00 itself is past it - pickup
 * 17:00 WIB, and no Saturday/Sunday pickups (Friday from 15:00 and the whole
 * weekend resolve to Monday). The rule itself lives in ONE pure function,
 * `resolvePickupSchedule` (shipping/pickup-schedule.ts), shared with the JNE slot
 * and the checkout notice; this module only wires it to the configured policy.
 *
 * The rule is shop-wide (P1 #13): Paxel is SENT the resolved slot, JNE only has
 * it RECORDED and sent as PICKUP_DATE/TIME. The class keeps its Paxel name because
 * Paxel is the only courier whose booking depends on it.
 *
 * WHY IT LIVES HERE, not in PaxelShipmentProvider: the resolver decides the
 * appointment, the provider only sends it. Keeping the decision out of the HTTP
 * client is what makes it testable without a courier, and keeps `formatPaxelDatetime`
 * a pure wire-format concern.
 */

/**
 * Resolve the automatic pickup appointment for a payment verified at `reference`.
 * Kept under its original name for every existing caller; the decision is
 * `resolvePickupSchedule`.
 */
export function resolveAutomaticPaxelPickupAt(reference: Date, policy: PickupPolicy): Date {
  return resolvePickupSchedule(reference, policy).pickupAt;
}

/**
 * The application-wired resolver. Thin on purpose: the decision is the pure
 * function above, this only supplies the configured policy and answers whether
 * automatic scheduling is switched on at all.
 */
@Injectable()
export class PaxelPickupScheduler {
  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  /**
   * Absent config means DISABLED. A courier must never be committed to an
   * automatically-invented appointment by an unset variable, so there is no path
   * by which omitting configuration yields automatic booking.
   */
  get enabled(): boolean {
    return this.config.paxel.autoPickup?.enabled === true;
  }

  /** ISO-8601 pickup instant for a payment verified at `verifiedAt`. */
  resolveIso(verifiedAt: Date): string {
    const policy = this.config.paxel.autoPickup;
    if (!policy?.enabled) {
      throw new PermanentError('Automatic Paxel pickup scheduling is disabled (PAXEL_AUTO_PICKUP_ENABLED)', 'paxel');
    }
    return resolveAutomaticPaxelPickupAt(verifiedAt, policy).toISOString();
  }

  /**
   * The shop-wide slot for a payment verified at `verifiedAt`, from the shared
   * rule and REGARDLESS of Paxel's automatic-booking switch - that switch decides
   * whether Paxel books on its own, not what the shop's pickup time is. For a
   * courier with no pickup contract (JNE): the slot is recorded for operations,
   * never sent to the courier and never allowed to gate its booking.
   */
  resolvePolicyIso(verifiedAt: Date): string {
    return resolveAutomaticPaxelPickupAt(verifiedAt, pickupPolicyOf(this.config)).toISOString();
  }
}
