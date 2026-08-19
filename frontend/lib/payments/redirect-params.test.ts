import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  channelLabel,
  isMidtransRedirect,
  orderNumberFromProviderOrderId,
  parseMidtransRedirect,
} from './redirect-params.ts'

test('recovers the order number from a Phase 5A provider order id', () => {
  // Phase 5A shape: {orderNumber}-{attemptId8}
  assert.equal(orderNumberFromProviderOrderId('BMS-20260810-001-a1b2c3d4'), 'BMS-20260810-001')
  // A value without the attempt suffix is returned unchanged.
  assert.equal(orderNumberFromProviderOrderId('BMS-20260810-001'), 'BMS-20260810-001')
  // Only a genuine 8-char hex suffix is stripped.
  assert.equal(orderNumberFromProviderOrderId('BMS-1-notahexsuffix'), 'BMS-1-notahexsuffix')
})

test('reads only display fields from a Midtrans redirect', () => {
  const params = new URLSearchParams({
    order_id: 'BMS-20260810-001-a1b2c3d4',
    transaction_status: 'settlement',
    status_code: '200',
    payment_type: 'qris',
    gross_amount: '40000.00',
  })
  const parsed = parseMidtransRedirect(params)

  assert.equal(parsed.orderNumber, 'BMS-20260810-001')
  assert.equal(parsed.channel, 'qris')
  assert.equal(parsed.amount, 40000)
  // No status is derived: the page never decides payment state from the URL.
  assert.equal('status' in parsed, false)
})

test('falls back to our own manual-flow ?order= parameter', () => {
  const parsed = parseMidtransRedirect(new URLSearchParams({ order: 'BMS-9' }))
  assert.equal(parsed.orderNumber, 'BMS-9')
  assert.equal(parsed.channel, null)
  assert.equal(parsed.amount, null)
})

test('refuses a malformed amount rather than guessing', () => {
  for (const raw of ['lots', '', '40.000,00', '-1', '1e5']) {
    assert.equal(parseMidtransRedirect(new URLSearchParams({ gross_amount: raw })).amount, null)
  }
  assert.equal(parseMidtransRedirect(new URLSearchParams({ gross_amount: '40000' })).amount, 40000)
})

test('distinguishes a Midtrans landing from the manual receipt-upload landing', () => {
  // This is what keeps the existing BANK_TRANSFER success copy intact.
  assert.equal(isMidtransRedirect(new URLSearchParams({ order_id: 'X' })), true)
  assert.equal(isMidtransRedirect(new URLSearchParams({ transaction_status: 'pending' })), true)
  assert.equal(isMidtransRedirect(new URLSearchParams({ status_code: '201' })), true)
  assert.equal(isMidtransRedirect(new URLSearchParams({ order: 'BMS-9' })), false)
  assert.equal(isMidtransRedirect(new URLSearchParams()), false)
})

test('labels channels for customers without leaking provider vocabulary', () => {
  assert.equal(channelLabel('qris'), 'QRIS')
  assert.equal(channelLabel('gopay'), 'GoPay')
  assert.equal(channelLabel('bank_transfer'), 'Virtual Account')
  assert.equal(channelLabel('credit_card'), 'Kartu Kredit / Debit')
  // Unknown types degrade readably rather than throwing.
  assert.equal(channelLabel('some_new_type'), 'some new type')
})
