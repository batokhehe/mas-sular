/**
 * Midtrans appends its own query parameters to the Finish / Unfinish / Error
 * redirect URLs. This module reads them for DISPLAY ONLY.
 *
 * They are NOT authoritative and are never treated as such: a customer can edit
 * them in the address bar. Payment state comes exclusively from the backend, driven
 * by the signed webhook. Nothing here mutates anything.
 */

export interface MidtransRedirect {
  /** The application order number, recovered from Midtrans's `order_id`. */
  orderNumber: string | null
  /** Raw `payment_type` (e.g. `qris`, `gopay`, `bank_transfer`). */
  channel: string | null
  /** `gross_amount` in whole rupiah, or null when absent/unparseable. */
  amount: number | null
}

/**
 * Phase 5A builds the provider order id as `{orderNumber}-{attemptId8}`, so the
 * customer-facing order number is everything before the final hyphen-delimited
 * 8-char attempt suffix. A value without that suffix is returned unchanged.
 */
export function orderNumberFromProviderOrderId(providerOrderId: string): string {
  const match = /^(.*)-[0-9a-f]{8}$/i.exec(providerOrderId)
  return match ? match[1] : providerOrderId
}

/** Whole rupiah from Midtrans's decimal string ("40000.00"), else null. */
function rupiah(raw: string | null): number | null {
  if (!raw) return null
  const match = /^(\d+)(?:\.\d{1,2})?$/.exec(raw.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

export function parseMidtransRedirect(params: URLSearchParams): MidtransRedirect {
  // `order` is our own manual-flow parameter; `order_id` is Midtrans's.
  const providerOrderId = params.get('order_id')
  const ownOrder = params.get('order')

  return {
    orderNumber: providerOrderId
      ? orderNumberFromProviderOrderId(providerOrderId)
      : ownOrder,
    channel: params.get('payment_type'),
    amount: rupiah(params.get('gross_amount')),
  }
}

/** True when the landing was reached from a Midtrans redirect (vs. our own flow). */
export function isMidtransRedirect(params: URLSearchParams): boolean {
  return params.has('order_id') || params.has('transaction_status') || params.has('status_code')
}

const CHANNEL_LABELS: Record<string, string> = {
  qris: 'QRIS',
  gopay: 'GoPay',
  shopeepay: 'ShopeePay',
  bank_transfer: 'Virtual Account',
  echannel: 'Mandiri Bill',
  credit_card: 'Kartu Kredit / Debit',
  cstore: 'Gerai Retail',
}

/** Customer-facing label for a raw Midtrans `payment_type`. */
export function channelLabel(paymentType: string): string {
  return CHANNEL_LABELS[paymentType.toLowerCase()] ?? paymentType.replace(/_/g, ' ')
}
