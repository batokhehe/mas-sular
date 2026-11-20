import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconcileShippingSelection } from './shipping-selection.ts'

/**
 * The checkout selection always comes from the CURRENT /checkout/shipping-options
 * response (the server withholds Paxel Same Day there). A selection from an earlier
 * response can never stay on screen as if still offered.
 */

const opt = (provider: string, service: string, shippingCost: number) => ({ provider, service, serviceName: service, estimatedDays: '1', shippingCost })
const SAMEDAY = opt('paxel', 'PAXEL_SAMEDAY', 25000)
const NEXTDAY = opt('paxel', 'PAXEL_NEXTDAY', 18000)
const REGULAR = opt('paxel', 'PAXEL_REGULAR', 15000)
const JNE_REG = opt('jne', 'REG23', 13000)
const CURRENT = [NEXTDAY, REGULAR, JNE_REG] // what the server returns now: no Same Day

test('first load: the cheapest current option is selected', () => {
  assert.equal(reconcileShippingSelection(null, CURRENT), JNE_REG)
})

test('a still-offered selection is kept, using the fresh option (current price)', () => {
  const stale = { ...NEXTDAY, shippingCost: 99000 }
  assert.equal(reconcileShippingSelection(stale, CURRENT), NEXTDAY)
  // Once it is the fresh object, nothing changes (no render loop).
  assert.equal(reconcileShippingSelection(NEXTDAY, CURRENT), NEXTDAY)
})

test('a stale Same Day selection is dropped and replaced by the cheapest current option', () => {
  assert.equal(reconcileShippingSelection(SAMEDAY, CURRENT), JNE_REG)
  assert.equal(reconcileShippingSelection(SAMEDAY, [NEXTDAY, REGULAR]), REGULAR)
})

test('no options: no selection', () => {
  assert.equal(reconcileShippingSelection(SAMEDAY, []), null)
  assert.equal(reconcileShippingSelection(null, []), null)
})

test('the checkout page reconciles its selection with the current options', () => {
  const page = readFileSync(join(import.meta.dirname, '..', '..', 'app/checkout/page.tsx'), 'utf8').replace(/\s+/g, ' ')
  assert.match(page, /const next = reconcileShippingSelection\(selectedShipping, shippingOptions\)/)
  assert.match(page, /if \(next !== selectedShipping\) setSelectedShipping\(next\)/)
  // The list itself is still the server response, unfiltered by the client.
  assert.match(page, /const shippingOptions = shippingQuery\.data \?\? \[\]/)
})
