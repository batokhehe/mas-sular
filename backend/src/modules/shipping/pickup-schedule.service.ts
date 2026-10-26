import { Inject, Injectable, Optional } from '@nestjs/common';
import { PickupScheduleReason, resolvePickupSchedule } from './pickup-schedule';
import { DEFAULT_PICKUP_POLICY, pickupPolicyOf, SHIPPING_CONFIG, ShippingConfig } from './shipping.config';

/**
 * The pickup schedule a checkout shows, as sent with every shipping option.
 *
 * `pickupAt`/`reason` are what the shop's rule answers for a payment verified AT
 * `referenceAt` (the quote time). They are an INDICATION: the courier is booked
 * from the real `payment.verifiedAt`, which may be later. The policy fields let
 * the storefront word its notice without carrying a copy of the rule.
 */
export interface CheckoutPickupSchedule {
  pickupAt: string;
  reason: PickupScheduleReason;
  referenceAt: string;
  timeZone: string;
  cutoffTime: string;
  pickupTime: string;
}

/**
 * The shop pickup rule for read-only callers outside the booking path (checkout).
 * Uses the SAME configured policy the booking path uses (SHIPPING_CONFIG, loaded
 * once at boot), so the notice can never describe a different rule than the one
 * the courier is booked with.
 */
@Injectable()
export class PickupScheduleService {
  constructor(@Optional() @Inject(SHIPPING_CONFIG) private readonly config?: ShippingConfig) {}

  forReference(referenceAt: Date): CheckoutPickupSchedule {
    const policy = this.config ? pickupPolicyOf(this.config) : DEFAULT_PICKUP_POLICY;
    const { pickupAt, reason } = resolvePickupSchedule(referenceAt, policy);
    return {
      pickupAt: pickupAt.toISOString(),
      reason,
      referenceAt: referenceAt.toISOString(),
      timeZone: policy.timeZone,
      cutoffTime: policy.cutoffTime,
      pickupTime: policy.pickupTime,
    };
  }
}
