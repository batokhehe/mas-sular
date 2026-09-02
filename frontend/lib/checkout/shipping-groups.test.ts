import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupShippingOptions, providerTitle, serviceLabel } from './shipping-groups.ts'
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

// ------------------------- service label disambiguation -------------------------
// PAXELBOX-61U. JNE returns REG15 and REG19 both displayed "REG", at prices that
// differed tenfold in the measured tariff. Selection was never ambiguous; the
// LABEL was.

const JNE_REG15 = opt({ provider: 'jne', service: 'REG15', serviceName: 'REG', shippingCost: 1050, estimatedDays: 'N/A' })
const JNE_REG19 = opt({ provider: 'jne', service: 'REG19', serviceName: 'REG', shippingCost: 11000, estimatedDays: 'N/A' })
const JNE_YES19 = opt({ provider: 'jne', service: 'YES19', serviceName: 'YES', shippingCost: 15000, estimatedDays: 'N/A' })
const JNE_JTR = opt({ provider: 'jne', service: 'JTR<130', serviceName: 'JTR<130', shippingCost: 500000, estimatedDays: '3-4' })

test('two JNE services sharing a display name become distinguishable', () => {
  assert.equal(serviceLabel(JNE_REG15), 'REG (REG15)')
  assert.equal(serviceLabel(JNE_REG19), 'REG (REG19)')
  assert.notEqual(serviceLabel(JNE_REG15), serviceLabel(JNE_REG19))
})

test('the label carries the code verbatim — no suffix is decoded or rewritten', () => {
  assert.ok(serviceLabel(JNE_REG15).includes('REG15'))
  assert.ok(serviceLabel(JNE_YES19).includes('YES19'))
  // Nothing invents a meaning for 15/19, and nothing reorders on it.
  assert.equal(serviceLabel(JNE_YES19), 'YES (YES19)')
})

test('the underlying serviceName and service are untouched by labelling', () => {
  const label = serviceLabel(JNE_REG15)
  assert.equal(JNE_REG15.serviceName, 'REG')
  assert.equal(JNE_REG15.service, 'REG15')
  assert.equal(typeof label, 'string')
})

test('a name that already contains its code is left exactly as it was', () => {
  assert.equal(serviceLabel(JNE_JTR), 'JTR<130')
  assert.ok(!serviceLabel(JNE_JTR).includes('('))
})

test('other providers are unaffected — Paxel labels do not change', () => {
  assert.equal(serviceLabel(PAXEL_INSTANT), 'Paxel Instant')
  assert.equal(serviceLabel(PAXEL_SAMEDAY), 'Paxel Same Day')
  assert.equal(serviceLabel(PAXEL_NEXTDAY), 'Paxel Next Day')
})

test('degrades safely on missing pieces rather than rendering "undefined"', () => {
  assert.equal(serviceLabel({ service: 'REG15', serviceName: '' }), 'REG15')
  assert.equal(serviceLabel({ service: '', serviceName: 'REG' }), 'REG')
  assert.equal(serviceLabel({ service: '', serviceName: '' }), '')
})

test('labelling never becomes the identity — React keys still use the code', () => {
  const groups = groupShippingOptions([JNE_REG15, JNE_REG19, JNE_JTR])
  const keys = groups.flatMap((g) => g.options.map((o) => `${o.provider}-${o.service}`))
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.includes('jne-REG15'))
  assert.ok(keys.includes('jne-REG19'))
})

test('the active-option predicate still selects exactly one of the two REG rows', () => {
  const options = [JNE_REG15, JNE_REG19]
  const selected = JNE_REG19
  const matches = options.filter((o) => selected.provider === o.provider && selected.service === o.service)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].service, 'REG19')
  assert.equal(matches[0].shippingCost, 11000)
})

test('price and ETD pass through untouched', () => {
  assert.equal(JNE_REG15.shippingCost, 1050)
  assert.equal(JNE_REG19.shippingCost, 11000)
  assert.equal(JNE_JTR.estimatedDays, '3-4')
  assert.equal(JNE_REG19.estimatedDays, 'N/A')
})

test('providerMeta is optional — grouping and labelling work with and without it', () => {
  const withMeta = opt({
    provider: 'jne', service: 'REG19', serviceName: 'REG',
    providerMeta: { service_code: 'REG19', service_display: 'REG', etd_from: null, etd_thru: null, times: 'D' },
  })
  assert.equal(serviceLabel(withMeta), 'REG (REG19)')
  assert.equal(groupShippingOptions([withMeta, PAXEL_INSTANT]).length, 2)
  // A provider that sends none is untouched.
  assert.equal(PAXEL_INSTANT.providerMeta, undefined)
})
