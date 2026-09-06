/**
 * Business wall-clock time.
 *
 * The admin UI's `<input type="datetime-local">` sends a NAKED wall clock —
 * "2026-09-12T09:59" — with no offset and no zone. That string is meaningless on
 * its own: it only becomes an instant once you say which clock it was read from.
 * For this shop that clock is Asia/Jakarta, and this module is the single place
 * that says so.
 *
 * WHY NOT `new Date("2026-09-12T09:59")`
 *
 * ECMAScript treats a date-time form with no offset as LOCAL time, i.e. the Node
 * process timezone. That is Asia/Jakarta on a developer machine but UTC inside
 * the container — no TZ is set in any Dockerfile — so the same admin action
 * would store two different instants seven hours apart depending on where it
 * ran. The application has already been bitten by exactly this once: Paxel
 * pickup slots were shifted by seven hours in production while looking correct
 * locally (see `formatPaxelDatetime`). The process timezone is therefore never
 * consulted here.
 *
 * RELATED, DELIBERATELY NOT MERGED (yet)
 *
 * `paxel-pickup-scheduler.ts` performs the same civil-to-instant conversion for
 * the automatic courier pickup rule. It is a Paxel POLICY resolver rather than a
 * general parser, and unifying the two means touching courier code that this
 * change has no business touching. The duplication is small, both sides are
 * pinned by tests, and folding the scheduler onto this module is a clean
 * follow-up.
 */

/** The wall clock every admin-entered business time is read from. */
export const BUSINESS_TIMEZONE = 'Asia/Jakarta';

/**
 * A browser `datetime-local` value: `YYYY-MM-DDTHH:mm`, optionally with seconds
 * and milliseconds, and CRUCIALLY with no trailing offset. A date on its own
 * ("2026-09-12") is not accepted — a promo boundary is a moment, and silently
 * turning a bare date into midnight would invent a precision the admin did not
 * supply.
 */
const NAKED_LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/** Anything ending in `Z` or `±HH:mm` already names its own instant. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

interface CivilFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** The civil (wall-clock) fields of `instant` as read in `timeZone`. */
function zonedCivil(instant: Date, timeZone: string): Omit<CivilFields, 'millisecond'> {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // 'h23' rather than hour12:false — the latter renders midnight as hour "24"
    // on some ICU versions, which would read back as the wrong day.
    hourCycle: 'h23',
  }).formatToParts(instant)) {
    parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const c = zonedCivil(instant, timeZone);
  const flooredToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - flooredToSecond;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given civil time.
 *
 * Two passes: the offset must be sampled at the TARGET instant, and a single
 * guess can land on the wrong side of a transition. Asia/Jakarta has no DST, so
 * the second pass is a no-op there — it is here so the function is correct by
 * construction rather than accidentally right for one zone.
 */
function instantFromCivil(c: CivilFields, timeZone: string): Date {
  const asIfUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, c.millisecond);
  let guess = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  guess = asIfUtc - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/**
 * Parse an admin-supplied business datetime into a real instant.
 *
 * Two accepted shapes, and the difference between them is the whole point:
 *
 *   "2026-09-12T09:59"            -> read as 09:59 in Asia/Jakarta (02:59Z)
 *   "2026-09-12T09:59:00+07:00"   -> already an instant; respected verbatim
 *   "2026-09-12T02:59:00.000Z"    -> already an instant; respected verbatim
 *
 * An API client that states an offset means it; only a NAKED wall clock is
 * interpreted, and it is interpreted as business time rather than as whatever
 * the server's clock happens to be.
 *
 * Returns null for anything unparseable or out of range, so the caller can raise
 * an ordinary 400 instead of letting a bad string reach the database driver.
 */
export function parseBusinessDateTime(value: string): Date | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const naked = NAKED_LOCAL_DATETIME.exec(raw);
  if (naked) {
    const civil: CivilFields = {
      year: Number(naked[1]),
      month: Number(naked[2]),
      day: Number(naked[3]),
      hour: Number(naked[4]),
      minute: Number(naked[5]),
      second: Number(naked[6] ?? '0'),
      millisecond: Number((naked[7] ?? '').padEnd(3, '0') || '0'),
    };
    // Range check first: the regex matches the SHAPE, so "2026-99-99T09:59" and
    // "2026-09-12T25:99" get this far and must be refused rather than rolled
    // over into some other date by Date.UTC's normalisation.
    if (civil.month < 1 || civil.month > 12) return null;
    if (civil.day < 1 || civil.day > 31) return null;
    if (civil.hour > 23 || civil.minute > 59 || civil.second > 59) return null;

    const instant = instantFromCivil(civil, BUSINESS_TIMEZONE);
    if (Number.isNaN(instant.getTime())) return null;

    // Round-trip: catches the dates a range check cannot, such as 30 February,
    // which Date.UTC would silently turn into 1 or 2 March.
    const back = zonedCivil(instant, BUSINESS_TIMEZONE);
    if (
      back.year !== civil.year ||
      back.month !== civil.month ||
      back.day !== civil.day ||
      back.hour !== civil.hour ||
      back.minute !== civil.minute
    ) {
      return null;
    }
    return instant;
  }

  // Already carries its own offset: trust it, do not reinterpret it.
  if (HAS_OFFSET.test(raw)) {
    const instant = new Date(raw);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }

  // A bare date, a bare time, or noise. Refused rather than guessed at.
  return null;
}

/**
 * Render an instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input needs,
 * in business time. The inverse of the naked-wall-clock branch above.
 */
export function formatBusinessDateTimeLocal(instant: Date): string {
  const c = zonedCivil(instant, BUSINESS_TIMEZONE);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}
