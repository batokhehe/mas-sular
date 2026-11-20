/**
 * Notice shown after a proof-of-transfer upload - PURE (no React, no DOM) so
 * node --test can load it. The admin WhatsApp number is NEXT_PUBLIC_WHATSAPP_NUMBER,
 * the same public build-time setting the floating support button uses
 * (lib/support/whatsapp.ts); nothing here hardcodes a number.
 */
import { buildWhatsAppUrl, normalizeWhatsAppNumber } from '../support/whatsapp.ts'

export const VERIFICATION_NOTICE_TEXT = 'Pembayaranmu sedang diverifikasi. Mohon tunggu konfirmasi admin melalui Whatsapp'

export interface VerificationNotice {
  /** The sentence before the number (always shown). */
  text: string
  /** The admin number for display ("+62…"), or null when unset/invalid. */
  phone: string | null
  /** wa.me link to that number, or null when unset/invalid. */
  whatsappUrl: string | null
}

export function paymentVerificationNotice(rawNumber: string | null | undefined): VerificationNotice {
  const number = normalizeWhatsAppNumber(rawNumber)
  return {
    text: VERIFICATION_NOTICE_TEXT,
    phone: number ? `+${number}` : null,
    whatsappUrl: number ? buildWhatsAppUrl(number) : null,
  }
}
