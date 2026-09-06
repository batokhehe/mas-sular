import { Inject, Injectable } from '@nestjs/common';
import { PermanentError } from '../shipping/domain/shipping-errors';
import {
  isValidTimeZone,
  parseHhMm,
  PaxelAutoPickupConfig,
  SHIPPING_CONFIG,
  ShippingConfig,
} from '../shipping/shipping.config';

/**
 * The automatic Paxel pickup schedule (PAXELBOX-61AG.3.32).
 *
 * 61AG.3.31 left Paxel booking BLOCKED: its API genuinely requires
 * `pickup_datetime`, and the application had no model from which a slot could be
 * derived, so inventing one would have committed a courier to an appointment
 * nobody agreed to. The business has since stated a single global rule, and this
 * module is that rule — nothing more. It does NOT model operating hours, weekends,
 * holidays or per-outlet schedules; none of those exist in this repository and
 * none are guessed at here.
 *
 * THE RULE
 *   payment verification time <= PAXEL_PICKUP_CUTOFF_TIME  -> SAME calendar day
 *   payment verification time >  PAXEL_PICKUP_CUTOFF_TIME  -> NEXT calendar day
 *   ...in either case at PAXEL_PICKUP_DEFAULT_TIME, local to PAXEL_PICKUP_TIMEZONE.
 *
 * The cutoff is NOT "the latest pickup time". With the business values (cutoff
 * 17:00, pickup 19:00) the same-day appointment is deliberately two hours AFTER
 * the cutoff: the cutoff is the latest payment verification still eligible for
 * today's run.
 *
 * WHY IT LIVES HERE, not in PaxelShipmentProvider: the resolver decides the
 * appointment, the provider only sends it. Keeping the decision out of the HTTP
 * client is what makes it testable without a courier, and keeps `formatPaxelDatetime`
 * a pure wire-format concern.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The civil (wall-clock) fields of `instant` as read in `timeZone`.
 *
 * Deliberately NOT `Date#getHours()` and friends anywhere in this module: those
 * read the Node process timezone, which is Asia/Jakarta on a developer machine
 * and UTC inside the container (no TZ is set in any Dockerfile). That exact
 * discrepancy already shifted every Paxel booking by seven hours once
 * (see `formatPaxelDatetime`). The application server timezone must not affect
 * the result, so it is never consulted.
 */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // 'h23' rather than hour12:false — the latter renders midnight as hour "24"
    // on some ICU versions, which would parse back as the wrong day.
    hourCycle: 'h23',
  });
  for (const { type, value } of formatter.formatToParts(instant)) {
    parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - startOfMinute(instant);
}

function startOfMinute(instant: Date): number {
  return Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given civil time.
 *
 * Two passes, not one: the offset must be sampled at the *target* instant, and
 * the first guess can land on the wrong side of a DST transition. Asia/Jakarta
 * has no DST, so the second pass is a no-op there — it is here so the function
 * stays correct for any zone the business might configure later, rather than
 * being accidentally right for one.
 */
function instantFromZonedCivil(civil: ZonedParts, timeZone: string): Date {
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
  let guess = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  guess = asIfUtc - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/**
 * Resolve the automatic pickup appointment for a payment verified at `reference`.
 *
 * Pure and total: same input, same output, on any machine in any process
 * timezone. Returns the INSTANT; callers persist it as ISO-8601 and the provider
 * renders it into Paxel's wire format.
 *
 * Comparison granularity is the MINUTE, not the second. The business stated the
 * boundary in minutes ("17:00 is INCLUDED, 17:01 is the next-day case"), so a
 * verification at 17:00:30 belongs to the 17:00 minute and still catches today's
 * run. Comparing at second granularity would shrink "included" to a one-second
 * window, which is not what a 17:00 operational cutoff means.
 */
export function resolveAutomaticPaxelPickupAt(reference: Date, policy: PaxelAutoPickupConfig): Date {
  if (!(reference instanceof Date) || Number.isNaN(reference.getTime())) {
    throw new PermanentError('Automatic Paxel pickup needs a valid payment verification time', 'paxel');
  }
  if (!isValidTimeZone(policy.timeZone)) {
    throw new PermanentError(`PAXEL_PICKUP_TIMEZONE is not a valid IANA timezone ('${policy.timeZone}')`, 'paxel');
  }
  const cutoffMinutes = parseHhMm(policy.cutoffTime);
  const pickupMinutes = parseHhMm(policy.pickupTime);
  if (cutoffMinutes === null) {
    throw new PermanentError(`PAXEL_PICKUP_CUTOFF_TIME must be HH:mm (got '${policy.cutoffTime}')`, 'paxel');
  }
  if (pickupMinutes === null) {
    throw new PermanentError(`PAXEL_PICKUP_DEFAULT_TIME must be HH:mm (got '${policy.pickupTime}')`, 'paxel');
  }

  const local = zonedParts(reference, policy.timeZone);
  const localMinutes = local.hour * 60 + local.minute;

  // Civil date arithmetic, never UTC-date arithmetic: `Date.UTC` normalises a
  // day overflow, so "the 31st + 1" becomes the 1st of the next month (and 31 Dec
  // rolls the year) without any of it depending on where the process runs.
  const dayOffset = localMinutes <= cutoffMinutes ? 0 : 1;
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));

  return instantFromZonedCivil(
    {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      hour: Math.floor(pickupMinutes / 60),
      minute: pickupMinutes % 60,
    },
    policy.timeZone,
  );
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
}
