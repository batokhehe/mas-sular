import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMobileInput, isIndonesianMobile, toCanonicalMobile } from './phone.ts'

// PAXELBOX-61AG.3.20 — client-side mirror of the server's mobile contract.
// UX only: the backend normalises and decides. These assert the two do not drift.
// Synthetic numbers only (0812-0000-xxxx is not an allocated range).

const CANONICAL = '6281200000000'

test('accepts every supported input form and canonicalises to 628…', () => {
  for (const input of [
    '081200000000',
    '6281200000000',
    '+6281200000000',
    '81200000000',
    '0812-0000-0000',
    '0812 0000 0000',
    '+62 812 0000 0000',
    '(0812) 0000-0000',
  ]) {
    assert.equal(toCanonicalMobile(input), CANONICAL, `failed for ${input}`)
    assert.equal(isIndonesianMobile(input), true, `failed for ${input}`)
  }
})

test('rejects landlines — the address phone is for WhatsApp and the courier', () => {
  assert.equal(toCanonicalMobile('0211234567'), null)
  assert.equal(toCanonicalMobile('0221234567'), null)
  assert.equal(toCanonicalMobile('+62211234567'), null)
})

test('rejects malformed and foreign numbers', () => {
  for (const input of [
    'abcdefghij', 'ab12!@#$%^&*', '+62abc1234567', '62',
    '0812', '0812000000000000000', '', '   ', '--- ---',
    '+14155550100', '+6591230000',
  ]) {
    assert.equal(toCanonicalMobile(input), null, `should reject ${JSON.stringify(input)}`)
  }
})

test('rejects null and undefined without throwing', () => {
  assert.equal(toCanonicalMobile(null), null)
  assert.equal(toCanonicalMobile(undefined), null)
  assert.equal(isIndonesianMobile(undefined), false)
})

test('is idempotent on an already canonical value', () => {
  assert.equal(toCanonicalMobile(CANONICAL), CANONICAL)
})

// ---------------------------------------------------------------- format ----

test('formats typed digits as 0812-3456-7890', () => {
  assert.equal(formatMobileInput('081234567890'), '0812-3456-7890')
})

test('folds pasted +62 / 62 / bare-8 forms into the same national shape', () => {
  // The three things a customer realistically pastes.
  assert.equal(formatMobileInput('+6281234567890'), '0812-3456-7890')
  assert.equal(formatMobileInput('6281234567890'), '0812-3456-7890')
  assert.equal(formatMobileInput('81234567890'), '0812-3456-7890')
})

test('re-formats an already formatted value idempotently', () => {
  const once = formatMobileInput('0812-3456-7890')
  assert.equal(once, '0812-3456-7890')
  assert.equal(formatMobileInput(once), '0812-3456-7890')
})

test('strips separators the customer pastes', () => {
  assert.equal(formatMobileInput('0812 3456 7890'), '0812-3456-7890')
  assert.equal(formatMobileInput('(0812) 3456-7890'), '0812-3456-7890')
})

test('never fights partial input mid-typing', () => {
  assert.equal(formatMobileInput(''), '')
  assert.equal(formatMobileInput('0'), '0')
  assert.equal(formatMobileInput('0812'), '0812')
  assert.equal(formatMobileInput('08123'), '0812-3')
  assert.equal(formatMobileInput('081234567'), '0812-3456-7')
})

test('the formatted display value still canonicalises correctly', () => {
  // What the field shows must remain something the server accepts.
  assert.equal(toCanonicalMobile(formatMobileInput('+6281200000000')), CANONICAL)
})
