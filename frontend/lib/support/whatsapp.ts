/**
 * WhatsApp support link — PURE helpers (no React, no DOM) so node --test can load
 * them. The number and message come from NEXT_PUBLIC_WHATSAPP_NUMBER /
 * NEXT_PUBLIC_WHATSAPP_MESSAGE; nothing here hardcodes a number.
 */

/** E.164 allows at most 15 digits; below 10 cannot be a real mobile number with a country code. */
const MIN_DIGITS = 10
const MAX_DIGITS = 15

/**
 * Normalize a configured number to wa.me form (country code, digits only):
 *   "+62 811-0101"  -> "628110101"   (spaces, "+", "-", "(", ")" removed)
 *   "0811..."       -> "62811..."    (Indonesian trunk 0 -> country code 62)
 * Returns null for anything else (letters or other symbols, empty, wrong length), so
 * a broken link is never built.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const stripped = raw.trim().replace(/[\s+\-()]/g, '')
  if (!/^\d+$/.test(stripped)) return null
  const number = stripped.startsWith('0') ? `62${stripped.slice(1)}` : stripped
  if (number.startsWith('0') || number.length < MIN_DIGITS || number.length > MAX_DIGITS) return null
  return number
}

/**
 * https://wa.me/<number>, plus ?text=<encodeURIComponent(message)> when a non-blank
 * message is configured. Null when the number is missing or invalid.
 */
export function buildWhatsAppUrl(rawNumber: string | null | undefined, rawMessage?: string | null): string | null {
  const number = normalizeWhatsAppNumber(rawNumber)
  if (!number) return null
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
  return message ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : `https://wa.me/${number}`
}

export const WHATSAPP_ARIA_LABEL = 'Chat WhatsApp dengan Bakso Mas Sular'
export const WHATSAPP_LABEL = 'Butuh Bantuan Kak?'
