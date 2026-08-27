import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupShippingOptions, providerTitle } from './shipping-groups.ts'
import type { ShippingOption } from '../types/models.ts'

const opt = (over: Partial<ShippingOption>): ShippingOption => ({
  provider: 'paxel', service: 'PAXEL_INSTANT', serviceName: 'Paxel Instant',
  estimatedDays: '00:00-24:00', shippingCost: 44000, ...over,
})

const PAXEL_INSTANT = opt({})
const PAXEL_SAMEDAY = opt({ service: 'PAXEL_SAMEDAY', serviceName: 'Paxel Same Day', shippingCost: 78000 })
const PAXEL_NEXTDAY = opt({ service: 'PAXEL_NEXTDAY', serviceName: 'Paxel Next Day', shippingCost: 78000 })
const JNE_REG = opt({ provider: 'jne', service: 'REG', serviceName: 'JNE Reguler (Mock)', shippingCost: 9000 })
const JNE_YES = opt({ provider: 'jne', service: 'YES', serviceName: 'JNE Yakin Esok Sampai (Mock)', shippingCost: 18000 })

// --------------------------- grouping by provider ---------------------------

test('groups Paxel services under one provider group', () => {
  const groups = groupShippingOptions([PAXEL_INSTANT, PAXEL_SAMEDAY, PAXEL_NEXTDAY, JNE_REG])
  const paxel = groups.find((g) => g.provider === 'paxel')
  assert.ok(paxel)
  assert.equal(paxel.title, 'Paxel')
  assert.deepEqual(paxel.options.map((o) => o.service), ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY'])
})

test('groups JNE services under one provider group', () => {
  const groups = groupShippingOptions([PAXEL_INSTANT, JNE_REG, JNE_YES])
  const jne = groups.find((g) => g.provider === 'jne')
  assert.ok(jne)
  assert.equal(jne.title, 'JNE')
  assert.deepEqual(jne.options.map((o) => o.service), ['REG', 'YES'])
})

test('preserves provider order as first seen in the backend response', () => {
  const paxelFirst = groupShippingOptions([PAXEL_INSTANT, JNE_REG])
  assert.deepEqual(paxelFirst.map((g) => g.provider), ['paxel', 'jne'])

  // Backend order flipped -> UI order flips too. Nothing is re-sorted.
  const jneFirst = groupShippingOptions([JNE_REG, PAXEL_INSTANT])
  assert.deepEqual(jneFirst.map((g) => g.provider), ['jne', 'paxel'])
})

test('preserves service order within a provider (no re-sorting by price)', () => {
  // Deliberately not price-ordered: 78000 before 44000.
  const [paxel] = groupShippingOptions([PAXEL_SAMEDAY, PAXEL_INSTANT, PAXEL_NEXTDAY])
  assert.deepEqual(paxel.options.map((o) => o.service), ['PAXEL_SAMEDAY', 'PAXEL_INSTANT', 'PAXEL_NEXTDAY'])
})

test('interleaved backend ordering still collapses into two groups', () => {
  const groups = groupShippingOptions([PAXEL_INSTANT, JNE_REG, PAXEL_SAMEDAY, JNE_YES, PAXEL_NEXTDAY])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.provider), ['paxel', 'jne'])
  assert.deepEqual(groups[0].options.map((o) => o.service), ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY'])
  assert.deepEqual(groups[1].options.map((o) => o.service), ['REG', 'YES'])
})

test('an unknown future provider is rendered, never dropped', () => {
  const sicepat = opt({ provider: 'sicepat', service: 'BEST', serviceName: 'SiCepat BEST' })
  const groups = groupShippingOptions([PAXEL_INSTANT, sicepat, JNE_REG])
  assert.deepEqual(groups.map((g) => g.provider), ['paxel', 'sicepat', 'jne'])
  // Falls back to a capitalised code rather than disappearing for want of a label.
  assert.equal(groups[1].title, 'Sicepat')
  assert.equal(groups[1].options.length, 1)
})

test('empty input returns no groups', () => {
  assert.deepEqual(groupShippingOptions([]), [])
})

test('never produces an empty provider group', () => {
  const groups = groupShippingOptions([PAXEL_INSTANT, JNE_REG, JNE_YES])
  for (const group of groups) assert.ok(group.options.length > 0)
})

// ------------------------- selection must not change -------------------------

test('does not mutate the input array or its objects', () => {
  const input = [PAXEL_INSTANT, JNE_REG, PAXEL_SAMEDAY]
  const snapshot = [...input]
  const before = JSON.stringify(input)

  groupShippingOptions(input)

  assert.deepEqual(input, snapshot, 'input array order changed')
  assert.equal(JSON.stringify(input), before, 'input objects were mutated')
  assert.equal(input.length, 3)
})

test('grouped options are the SAME object references, so selection is unchanged', () => {
  const input = [PAXEL_INSTANT, JNE_REG, PAXEL_SAMEDAY]
  const groups = groupShippingOptions(input)
  const flattened = groups.flatMap((g) => g.options)

  // Identity, not deep equality: the page stores the clicked object in state and
  // submits provider+service off it, so a clone would be a behaviour change.
  assert.equal(flattened.length, input.length)
  assert.strictEqual(groups[0].options[0], PAXEL_INSTANT)
  assert.strictEqual(groups[0].options[1], PAXEL_SAMEDAY)
  assert.strictEqual(groups[1].options[0], JNE_REG)
})

test('the checkout active-option predicate still matches exactly one service', () => {
  const input = [PAXEL_INSTANT, PAXEL_SAMEDAY, PAXEL_NEXTDAY, JNE_REG, JNE_YES]
  const groups = groupShippingOptions(input)
  const selected = PAXEL_SAMEDAY

  // Mirrors app/checkout/page.tsx: active = provider match && service match.
  const matches = groups
    .flatMap((g) => g.options)
    .filter((o) => o.provider === selected.provider && o.service === selected.service)

  assert.equal(matches.length, 1)
  assert.strictEqual(matches[0], selected)
})

test('providerTitle labels known providers and degrades gracefully', () => {
  assert.equal(providerTitle('paxel'), 'Paxel')
  assert.equal(providerTitle('jne'), 'JNE')
  assert.equal(providerTitle('PAXEL'), 'Paxel')
  assert.equal(providerTitle('anteraja'), 'Anteraja')
  assert.equal(providerTitle(''), 'Lainnya')
})
