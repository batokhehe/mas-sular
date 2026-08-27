import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAYMENT_POLL_INTERVAL_MS,
  canResumeGatewayPayment,
  gatewayPaymentHref,
  paymentPageState,
  shouldPollPayment,
} from './resume.ts'

/** Deterministic clock — no sleeps, no real time. */
const NOW = Date.parse('2026-08-12T08:40:00.000Z')
const MINUTE = 60_000
const live = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  method: 'GATEWAY',
  status: 'PENDING',
  gateway: { expiryAt: new Date(NOW + 5 * MINUTE).toISOString() },
  ...over,
})

test('only a PENDING gateway payment offers "Bayar Sekarang"', () => {
  assert.equal(canResumeGatewayPayment(live(), NOW), true)

  // Settled or dead payments must never re-open a payable QR.
  for (const status of ['PAID', 'FAILED', 'EXPIRED', 'REFUNDED', 'WAITING_VERIFICATION']) {
    assert.equal(
      canResumeGatewayPayment(live({ status }), NOW),
      false,
      `${status} must not be resumable`,
    )
  }
})

test('manual methods keep the receipt flow and get no resume button', () => {
  // BANK_TRANSFER / QRIS have no gateway attempt to replay.
  assert.equal(canResumeGatewayPayment(live({ method: 'BANK_TRANSFER', gateway: null }), NOW), false)
  assert.equal(canResumeGatewayPayment(live({ method: 'QRIS', gateway: null }), NOW), false)
  assert.equal(canResumeGatewayPayment(live({ method: 'COD', gateway: null }), NOW), false)
})

test('an absent payment is not resumable', () => {
  assert.equal(canResumeGatewayPayment(null), false)
  assert.equal(canResumeGatewayPayment(undefined), false)
})

// ------------------------------------------------- expiry-aware gating (5J.8) --

test('a PENDING attempt still inside its window is resumable', () => {
  assert.equal(canResumeGatewayPayment(live(), NOW), true)
})

test('a PENDING attempt past its window is NOT resumable', () => {
  // Payment.status is still PENDING here — the provider expire notification has
  // not arrived yet. Without this check the button advertises a dead QR.
  const expired = live({ gateway: { expiryAt: new Date(NOW - MINUTE).toISOString() } })
  assert.equal(canResumeGatewayPayment(expired, NOW), false)
})

test('the exact expiry instant counts as expired', () => {
  const boundary = live({ gateway: { expiryAt: new Date(NOW).toISOString() } })
  assert.equal(canResumeGatewayPayment(boundary, NOW), false)
})

test('a null deadline stays resumable — it mirrors the backend gate', () => {
  // Backend: `attempt.expiryAt && attempt.expiryAt <= now`. A channel with no
  // deadline is payable, so the button must agree with the page it links to.
  assert.equal(canResumeGatewayPayment(live({ gateway: { expiryAt: null } }), NOW), true)
})

test('an unparseable deadline never blocks a customer from paying', () => {
  assert.equal(canResumeGatewayPayment(live({ gateway: { expiryAt: 'not-a-date' } }), NOW), true)
})

test('a GATEWAY payment with no attempt at all is not resumable', () => {
  // Charge never opened (checkout could not reach the provider): nothing to replay.
  assert.equal(canResumeGatewayPayment(live({ gateway: null }), NOW), false)
  assert.equal(canResumeGatewayPayment(live({ gateway: undefined }), NOW), false)
})

test('an expired attempt is hidden regardless of status, and settled ones stay hidden', () => {
  for (const status of ['PAID', 'FAILED', 'EXPIRED', 'REFUNDED', 'WAITING_VERIFICATION']) {
    const p = live({ status, gateway: { expiryAt: new Date(NOW - MINUTE).toISOString() } })
    assert.equal(canResumeGatewayPayment(p, NOW), false)
  }
})

test('resume navigates to the existing payment page by payment id', () => {
  // No QR data in the URL — the page re-reads it from the backend.
  assert.equal(gatewayPaymentHref('pay-123'), '/payment/gateway/pay-123')
})

test('a payable response renders the instructions', () => {
  const state = paymentPageState({ gateway: { qrString: 'QR' }, status: 'PENDING', expired: false })
  assert.equal(state, 'PAYABLE')
  assert.equal(shouldPollPayment(state), true)
})

test('a settled payment shows success and stops polling', () => {
  const state = paymentPageState({ gateway: null, status: 'PAID', expired: false })
  assert.equal(state, 'PAID')
  assert.equal(shouldPollPayment(state), false)
})

test('PAID wins over an elapsed window', () => {
  // The customer paid just before the deadline; success must not read as expired.
  assert.equal(paymentPageState({ gateway: null, status: 'PAID', expired: true }), 'PAID')
})

test('an expired attempt is reported as expired, not merely unavailable', () => {
  // Server-side expiry while Payment.status is still PENDING.
  const pending = paymentPageState({ gateway: null, status: 'PENDING', expired: true })
  assert.equal(pending, 'EXPIRED')
  assert.equal(shouldPollPayment(pending), false)

  // And once the lifecycle worker has flipped the row.
  assert.equal(paymentPageState({ gateway: null, status: 'EXPIRED', expired: false }), 'EXPIRED')
})

test('manual transfer and dead payments fall through to unavailable', () => {
  // Manual transfer: PENDING, never expired, no gateway attempt.
  const manual = paymentPageState({ gateway: null, status: 'PENDING', expired: false })
  assert.equal(manual, 'UNAVAILABLE')
  assert.equal(shouldPollPayment(manual), false)

  assert.equal(paymentPageState({ gateway: null, status: 'FAILED', expired: false }), 'UNAVAILABLE')
  assert.equal(paymentPageState({ gateway: null, status: 'REFUNDED', expired: false }), 'UNAVAILABLE')
})

test('polling stops in every non-payable state', () => {
  for (const state of ['PAID', 'EXPIRED', 'UNAVAILABLE'] as const) {
    assert.equal(shouldPollPayment(state), false, `${state} must not poll`)
  }
})

test('the poll interval stays in the intended 3-5s band', () => {
  assert.ok(PAYMENT_POLL_INTERVAL_MS >= 3000 && PAYMENT_POLL_INTERVAL_MS <= 5000)
})
