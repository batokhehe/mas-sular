/**
 * Resuming an unfinished gateway payment.
 *
 * A customer who closes the QRIS tab still has a live, persisted charge. These
 * helpers decide where they can pick it back up and what the payment page should
 * render — as pure functions, so the rules are testable without a DOM.
 *
 * Nothing here initiates a payment. Resuming is a GET against our own backend
 * that replays the stored attempt; the only path that opens a charge is checkout.
 */

import { isExpired } from './countdown.ts'

/** The payment fields the order list already carries. */
export interface ResumablePayment {
  id: string
  method: string
  status: string
  /** Latest gateway attempt summary from the order list; absent for manual transfer. */
  gateway?: { expiryAt: string | null } | null
}

/**
 * The one resumable combination: a gateway payment still awaiting the customer,
 * whose stored attempt has not passed its deadline.
 *
 * BANK_TRANSFER/QRIS keep the receipt-upload flow and must NOT get this button —
 * they have no gateway attempt to replay. Every settled or dead status is
 * excluded: re-opening a paid QR would invite a second, unreconciled payment.
 *
 * The expiry check matters because `Payment.status` stays PENDING until the
 * provider's expire notification arrives, which can lag by hours — without it the
 * button advertises a QR that is already dead.
 *
 * Expiry semantics come from the canonical `isExpired`, so a null or unparseable
 * deadline is NOT expired. That deliberately mirrors the backend gate
 * (`attempt.expiryAt && attempt.expiryAt <= now`): a channel with no deadline
 * stays payable, and the button must not disagree with the page it links to.
 *
 * This is a convenience gate only. The backend re-checks both status and expiry
 * on every request and remains the authority.
 */
export function canResumeGatewayPayment(
  payment: ResumablePayment | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!payment) return false
  if (payment.method !== 'GATEWAY' || payment.status !== 'PENDING') return false
  if (!payment.gateway) return false // never initiated — nothing to resume
  return !isExpired(payment.gateway.expiryAt, now)
}

/** The existing payment page, addressed by payment id. */
export function gatewayPaymentHref(paymentId: string): string {
  return `/payment/gateway/${paymentId}`
}

/** What the payment page should show for a given instructions response. */
export type PaymentPageState = 'PAYABLE' | 'PAID' | 'EXPIRED' | 'UNAVAILABLE'

export interface InstructionsSnapshot {
  /** Null whenever the backend judged the payment not payable. */
  gateway: unknown | null
  status: string
  expired: boolean
}

/**
 * Collapse the response into one render decision.
 *
 * PAID is checked first: a settled payment must show success even if its window
 * has also elapsed. `gateway` is null for a settled payment, an expired attempt,
 * AND a manual transfer, which is exactly why `status`/`expired` exist.
 */
export function paymentPageState(snapshot: InstructionsSnapshot): PaymentPageState {
  if (snapshot.status === 'PAID') return 'PAID'
  if (snapshot.expired || snapshot.status === 'EXPIRED') return 'EXPIRED'
  if (snapshot.gateway) return 'PAYABLE'
  return 'UNAVAILABLE'
}

/** Poll interval while a charge is open, in ms. */
export const PAYMENT_POLL_INTERVAL_MS = 4000

/**
 * Keep polling only while the payment can still change under the customer —
 * i.e. while there is something payable on screen. Any settled, expired or
 * unavailable state is final for this page, so the timer stops and the tab goes
 * quiet. Polling hits OUR backend; the gateway is never called from the browser.
 */
export function shouldPollPayment(state: PaymentPageState): boolean {
  return state === 'PAYABLE'
}
