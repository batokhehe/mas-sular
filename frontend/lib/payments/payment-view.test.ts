import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgesFor, groupChannels, type PublicPaymentChannel } from './channel-view.ts'
import { formatCountdown, isExpired, remainingMs } from './countdown.ts'

const ch = (over: Partial<PublicPaymentChannel>): PublicPaymentChannel => ({
  code: 'X', label: 'X', group: 'EWALLET', method: 'GATEWAY', logoUrl: null,
  icon: 'x', sortOrder: 1, ...over,
})

// ----------------------------- payment selector -----------------------------

test('groups channels into the four checkout sections with the exact headings', () => {
  const sections = groupChannels([
    ch({ code: 'CREDIT_CARD', group: 'CARD', sortOrder: 50 }),
    ch({ code: 'MANUAL_TRANSFER', group: 'MANUAL', method: 'BANK_TRANSFER', sortOrder: 10 }),
    ch({ code: 'BCA_VA', group: 'VIRTUAL_ACCOUNT', sortOrder: 40 }),
    ch({ code: 'GOPAY', group: 'EWALLET', sortOrder: 30 }),
    ch({ code: 'QRIS', group: 'QR', sortOrder: 20 }),
  ])

  assert.deepEqual(sections.map((s) => s.title), [
    '🏦 Transfer Bank',
    '⚡ E-Wallet',
    '🏦 Virtual Account',
    '💳 Credit Card',
  ])
  // QR + EWALLET merge into one section, ordered by sortOrder.
  assert.deepEqual(sections[1].channels.map((c) => c.code), ['QRIS', 'GOPAY'])
})

test('sorts within a section by sortOrder, not input order', () => {
  const [section] = groupChannels([
    ch({ code: 'PERMATA_VA', group: 'VIRTUAL_ACCOUNT', sortOrder: 44 }),
    ch({ code: 'BCA_VA', group: 'VIRTUAL_ACCOUNT', sortOrder: 40 }),
    ch({ code: 'BNI_VA', group: 'VIRTUAL_ACCOUNT', sortOrder: 41 }),
  ])
  assert.deepEqual(section.channels.map((c) => c.code), ['BCA_VA', 'BNI_VA', 'PERMATA_VA'])
})

test('drops empty sections — an unavailable channel is simply not offered', () => {
  const sections = groupChannels([ch({ code: 'MANUAL_TRANSFER', group: 'MANUAL', method: 'BANK_TRANSFER' })])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].title, '🏦 Transfer Bank')
})

test('badges are rendered from backend metadata only', () => {
  assert.deepEqual(badgesFor(ch({ recommended: true })), ['Disarankan'])
  assert.deepEqual(badgesFor(ch({ popular: true, instant: true })), ['Populer', 'Instan'])
  assert.deepEqual(badgesFor(ch({})), [])
})

// -------------------------------- countdown ---------------------------------

test('formats remaining time as HH:mm:ss', () => {
  assert.equal(formatCountdown(0), '00:00:00')
  assert.equal(formatCountdown(1000), '00:00:01')
  assert.equal(formatCountdown(61_000), '00:01:01')
  assert.equal(formatCountdown(3_661_000), '01:01:01')
  assert.equal(formatCountdown(24 * 3600 * 1000), '24:00:00') // hours are not capped
})

test('negative/expired input never renders a negative clock', () => {
  assert.equal(formatCountdown(-5000), '00:00:00')
  assert.equal(remainingMs('2020-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z')), 0)
})

test('remainingMs counts down from expiryAt', () => {
  const now = Date.parse('2026-07-11T10:00:00Z')
  assert.equal(remainingMs('2026-07-11T10:00:30Z', now), 30_000)
  assert.equal(formatCountdown(remainingMs('2026-07-11T11:30:15Z', now)), '01:30:15')
})

test('a missing or invalid expiry is not expired (manual transfer has no deadline)', () => {
  assert.equal(isExpired(null), false)
  assert.equal(isExpired(undefined), false)
  assert.equal(isExpired('not-a-date'), false)
  assert.equal(remainingMs('not-a-date'), 0)
})

test('isExpired flips exactly at the deadline', () => {
  const expiry = '2026-07-11T10:00:00Z'
  assert.equal(isExpired(expiry, Date.parse('2026-07-11T09:59:59Z')), false)
  assert.equal(isExpired(expiry, Date.parse('2026-07-11T10:00:00Z')), true)
})

// --- Phase 4A: the selector must never inject a synthetic option ---

test('the selector renders exactly what the API returns — no COD injected', () => {
  // The real catalog shape (COD is absent from GET /payments/channels).
  const apiChannels: PublicPaymentChannel[] = [
    ch({ code: 'MANUAL_TRANSFER', label: 'Transfer Bank', group: 'MANUAL', method: 'BANK_TRANSFER', sortOrder: 10 }),
    ch({ code: 'QRIS', label: 'QRIS', group: 'QR', sortOrder: 20 }),
    ch({ code: 'GOPAY', label: 'GoPay', group: 'EWALLET', sortOrder: 30 }),
    ch({ code: 'SHOPEEPAY', label: 'ShopeePay', group: 'EWALLET', sortOrder: 31 }),
    ch({ code: 'BCA_VA', label: 'BCA Virtual Account', group: 'VIRTUAL_ACCOUNT', sortOrder: 40 }),
    ch({ code: 'BNI_VA', label: 'BNI Virtual Account', group: 'VIRTUAL_ACCOUNT', sortOrder: 41 }),
    ch({ code: 'BRI_VA', label: 'BRI Virtual Account', group: 'VIRTUAL_ACCOUNT', sortOrder: 42 }),
    ch({ code: 'MANDIRI_BILL', label: 'Mandiri Virtual Account', group: 'VIRTUAL_ACCOUNT', sortOrder: 43 }),
    ch({ code: 'PERMATA_VA', label: 'Permata Virtual Account', group: 'VIRTUAL_ACCOUNT', sortOrder: 44 }),
    ch({ code: 'CREDIT_CARD', label: 'Kartu Kredit / Debit', group: 'CARD', sortOrder: 50 }),
  ]

  const sections = groupChannels(apiChannels)
  const rendered = sections.flatMap((s) => s.channels.map((c) => c.code))

  assert.ok(!rendered.includes('COD'), 'COD must never be rendered')
  assert.deepEqual(sections.map((s) => s.title), [
    '🏦 Transfer Bank',
    '⚡ E-Wallet',
    '🏦 Virtual Account',
    '💳 Credit Card',
  ])
  assert.deepEqual(sections[0].channels.map((c) => c.code), ['MANUAL_TRANSFER'])
  assert.deepEqual(sections[1].channels.map((c) => c.code), ['QRIS', 'GOPAY', 'SHOPEEPAY'])
  assert.deepEqual(sections[2].channels.map((c) => c.code), ['BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA'])
  assert.deepEqual(sections[3].channels.map((c) => c.code), ['CREDIT_CARD'])
})

test('an empty API response renders no payment options at all (nothing synthetic)', () => {
  assert.deepEqual(groupChannels([]), [])
})
