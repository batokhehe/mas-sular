/**
 * PAXELBOX-61AG.3.20 — Indonesian mobile phone input helpers.
 *
 * UX ONLY. The backend normalises to canonical `628…` and is the sole authority
 * on what may be stored; this exists so the field behaves like a phone field
 * while typing, not to decide what is valid. Mirrors
 * backend/src/common/utils/phone.util.ts so the two do not drift.
 *
 * Accepted input: 08…, 62…, +62…, 8…, with spaces, hyphens or parentheses.
 */

/** Digits only, discarding +, spaces, hyphens and parentheses. */
function digitsOf(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

/**
 * Canonical `628…` form, or null when the value is not an Indonesian mobile.
 *
 * Same rules as the server: normalise the prefix, require 11–15 digits, and
 * require the result to begin `628` — a landline (`0211234567` → `62211234567`)
 * is not a mobile and is rejected here as it is there.
 */
export function toCanonicalMobile(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const digits = digitsOf(raw)
  if (!digits) return null

  let msisdn: string
  if (digits.startsWith('62')) msisdn = digits
  else if (digits.startsWith('0')) msisdn = `62${digits.slice(1)}`
  else if (digits.startsWith('8')) msisdn = `62${digits}`
  else return null

  if (msisdn.length < 11 || msisdn.length > 15) return null
  if (!msisdn.startsWith('628')) return null
  return msisdn
}

/** True when the value is an Indonesian mobile number in any accepted form. */
export function isIndonesianMobile(raw: string | null | undefined): boolean {
  return toCanonicalMobile(raw) !== null
}

/**
 * Display form while typing: `0812-3456-7890`.
 *
 * Normalises whatever the customer typed or pasted to the national `08…` form
 * first, so pasting `+6281234567890` or `62 812 3456 7890` settles into the same
 * shape. Grouping is 4-4-rest, which is how Indonesian mobiles are usually
 * written. Partial input is left alone rather than fought with — the formatter
 * must never block someone mid-number.
 */
export function formatMobileInput(raw: string): string {
  const digits = digitsOf(raw)
  if (!digits) return ''

  // Fold every accepted prefix to the national 0-form for display.
  let national: string
  if (digits.startsWith('62')) national = `0${digits.slice(2)}`
  else if (digits.startsWith('8')) national = `0${digits}`
  else national = digits

  // Cap at the longest national mobile (0 + 62-form's 13 subscriber digits).
  national = national.slice(0, 14)

  const a = national.slice(0, 4)
  const b = national.slice(4, 8)
  const c = national.slice(8)
  return [a, b, c].filter(Boolean).join('-')
}
