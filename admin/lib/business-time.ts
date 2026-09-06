/**
 * Business wall-clock time for the admin UI.
 *
 * The counterpart of the backend's `business-time.util.ts`. It lives here rather
 * than being imported because admin is a separate Next application with its own
 * dependency graph — the same split the repository already uses for phone
 * normalisation (`frontend/lib/address/phone.ts` beside `backend/.../phone.util.ts`).
 *
 * Only the direction this app needs is implemented: instant -> wall clock. The
 * other direction is the API's job, and duplicating it here would create exactly
 * the second opinion about what "09:59" means that the backend module exists to
 * prevent.
 */

/** Must match the backend's BUSINESS_TIMEZONE. */
export const BUSINESS_TIMEZONE = 'Asia/Jakarta';

/**
 * Render an API instant as the `YYYY-MM-DDTHH:mm` an `<input type="datetime-local">`
 * requires.
 *
 * WHY THIS IS NEEDED AT ALL: the API returns a full ISO instant
 * ("2026-09-12T02:59:00.000Z"). A datetime-local input REFUSES any value
 * carrying `Z` or an offset — it sanitises it to the empty string — so feeding
 * the API value in directly showed a blank date field for every promo that
 * actually had one. Verified in a browser: "2026-09-12T02:59:00.000Z",
 * "2026-09-12T02:59:00Z" and "2026-09-12T09:59:00+07:00" all render as "".
 *
 * Deliberately NOT `toISOString().slice(0, 16)`: that shows the UTC wall clock,
 * so a promo starting 09:59 in Jakarta would be presented to the admin as 02:59.
 * And deliberately not `getHours()`, which reads the browser's timezone — an
 * admin travelling, or a machine with a stale zone, would see and then re-save a
 * different time than the business meant.
 */
export function toDateTimeLocalValue(value: string | Date | null | undefined): string {
  if (!value) return '';
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '';

  const parts: Record<string, string> = {};
  for (const { type, value: part } of new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // 'h23', not hour12:false — the latter renders midnight as "24" on some ICU
    // versions, which the input would then reject.
    hourCycle: 'h23',
  }).formatToParts(instant)) {
    parts[type] = part;
  }

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
