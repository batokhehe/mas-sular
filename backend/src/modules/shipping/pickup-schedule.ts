import { PermanentError } from './domain/shipping-errors';
import { isValidTimeZone, parseHhMm, PickupPolicy } from './shipping.config';

/**
 * The shop's courier pickup schedule — ONE pure function for every courier and
 * every caller (Paxel booking, the JNE slot, the checkout notice).
 *
 * THE RULE (approved business policy, Phase 2)
 *   Reference: the payment VERIFICATION instant (`payment.verifiedAt`).
 *   Read as a wall clock in the policy timezone (Asia/Jakarta), never the process one.
 *
 *   before the cut-off (15:00 WIB)       -> the SAME calendar day
 *   at or after the cut-off              -> the NEXT calendar day
 *   ...then, if that day is a Saturday or Sunday, the following Monday.
 *
 *   which gives:
 *     Mon-Thu before 15:00   same day        Mon-Thu from 15:00   next day
 *     Fri before 15:00       Friday          Fri from 15:00       Monday
 *     Saturday / Sunday      Monday, whatever the time
 *   ...always at the pickup time (17:00 WIB).
 *
 * 15:00 itself is PAST the cut-off. Comparison is per MINUTE, so 15:00:30 is the
 * 15:00 minute and therefore also past the cut-off; 14:59:59 is still before it.
 *
 * The result is the COURIER PICKUP appointment — when the parcel is handed over —
 * never a delivery or arrival estimate. Public holidays are not modelled: no
 * holiday calendar exists in this repository and none is invented here.
 *
 * Calendar arithmetic is civil (Date.UTC normalises a day overflow, so month and
 * year ends roll correctly) and never "add 24 hours".
 */

/** Why the appointment lands where it does — the checkout notice is chosen from this. */
export type PickupScheduleReason =
  /** Before the cut-off on a weekday: today. */
  | 'SAME_DAY'
  /** At/after the cut-off Monday-Thursday: tomorrow. */
  | 'NEXT_DAY'
  /** At/after the cut-off on Friday: the following Monday. */
  | 'MONDAY_AFTER_FRIDAY_CUTOFF'
  /** Saturday or Sunday, any time: the following Monday. */
  | 'MONDAY_AFTER_WEEKEND';

export interface PickupSchedule {
  /** The pickup appointment instant. */
  pickupAt: Date;
  reason: PickupScheduleReason;
}

/** Days the shop never books a courier pickup for (Date#getUTCDay numbering: 0 = Sunday). */
const NON_PICKUP_WEEKDAYS: ReadonlySet<number> = new Set([0, 6]);
const FRIDAY = 5;

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

/** Weekday (0 = Sunday) of a civil date; `day` may overflow the month. */
function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Resolve the pickup appointment for a payment verified at `reference`.
 *
 * Pure and total: same input, same output, on any machine in any process
 * timezone. Invalid input is refused, never defaulted (defaulting happens once,
 * in `loadPickupPolicy`, for UNSET configuration).
 */
export function resolvePickupSchedule(reference: Date, policy: PickupPolicy): PickupSchedule {
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
  const referenceWeekday = civilWeekday(local.year, local.month, local.day);

  // The cut-off minute itself is past the cut-off.
  const beforeCutoff = localMinutes < cutoffMinutes;
  let dayOffset = beforeCutoff ? 0 : 1;
  while (NON_PICKUP_WEEKDAYS.has(civilWeekday(local.year, local.month, local.day + dayOffset))) {
    dayOffset += 1;
  }

  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
  const pickupAt = instantFromZonedCivil(
    {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      hour: Math.floor(pickupMinutes / 60),
      minute: pickupMinutes % 60,
    },
    policy.timeZone,
  );

  let reason: PickupScheduleReason;
  if (NON_PICKUP_WEEKDAYS.has(referenceWeekday)) reason = 'MONDAY_AFTER_WEEKEND';
  else if (dayOffset === 0) reason = 'SAME_DAY';
  else if (referenceWeekday === FRIDAY) reason = 'MONDAY_AFTER_FRIDAY_CUTOFF';
  else reason = 'NEXT_DAY';

  return { pickupAt, reason };
}
