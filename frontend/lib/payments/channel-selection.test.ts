import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveChannelSelection, DEFAULT_CHANNEL_CODE } from './channel-view.ts'

/**
 * P0-3 — checkout only ever submits a channel GET /payments/channels returned.
 *
 * The backend now omits MANUAL_TRANSFER when no active bank account exists (and
 * refuses a BANK_TRANSFER order then). Before, the form defaulted to
 * 'MANUAL_TRANSFER' and fell back to payment_method BANK_TRANSFER whenever the
 * selected code was not in the list - an order that could never be paid.
 */

const list = (...codes: string[]) => codes.map((code) => ({ code }))
const MIDTRANS = ['QRIS', 'GOPAY', 'BCA_VA']

test('manual transfer offered: it stays the preselected default', () => {
  assert.equal(DEFAULT_CHANNEL_CODE, 'MANUAL_TRANSFER')
  assert.equal(resolveChannelSelection('', list('MANUAL_TRANSFER', ...MIDTRANS)), 'MANUAL_TRANSFER')
})

test('manual transfer NOT offered (0 active accounts): nothing is preselected - never a hidden channel', () => {
  assert.equal(resolveChannelSelection('', list(...MIDTRANS)), '')
  assert.equal(resolveChannelSelection('MANUAL_TRANSFER', list(...MIDTRANS)), '', 'a stale default is dropped')
})

test('a customer choice that is still offered is kept; one that disappeared is replaced', () => {
  assert.equal(resolveChannelSelection('GOPAY', list('MANUAL_TRANSFER', ...MIDTRANS)), 'GOPAY')
  assert.equal(resolveChannelSelection('SHOPEEPAY', list('MANUAL_TRANSFER', ...MIDTRANS)), 'MANUAL_TRANSFER')
  assert.equal(resolveChannelSelection('SHOPEEPAY', list(...MIDTRANS)), '')
})

test('no channels at all: empty selection', () => {
  assert.equal(resolveChannelSelection('MANUAL_TRANSFER', []), '')
})

// ----------------------------------------------------------------- wiring --

const CHECKOUT = readFileSync(join(import.meta.dirname, '..', '..', 'app/checkout/page.tsx'), 'utf8').replace(/\s+/g, ' ')

test('checkout: no hardcoded default, selection synced to the returned list, no BANK_TRANSFER fallback', () => {
  assert.match(CHECKOUT, /defaultValues: \{ courier: 'jne', payment_channel: '', voucher_code: '' \}/)
  assert.doesNotMatch(CHECKOUT, /payment_channel: 'MANUAL_TRANSFER'/)
  assert.match(CHECKOUT, /resolveChannelSelection\(getValues\('payment_channel'\), channelsQuery\.data\.channels\)/)
  assert.doesNotMatch(CHECKOUT, /\?\? 'BANK_TRANSFER'/)
  assert.match(CHECKOUT, /if \(!selectedChannel\) return/)
  assert.match(CHECKOUT, /payment_method: selectedChannel\.method as CreateOrderInput\['payment_method'\]/)
  // The radio list is still exactly what the API returned (groupChannels of the response).
  assert.match(CHECKOUT, /groupChannels\(channelsQuery\.data\?\.channels \?\? \[\]\)/)
  assert.match(CHECKOUT, /channelSections\.length === 0 \? \( <p role="status"/)
})
