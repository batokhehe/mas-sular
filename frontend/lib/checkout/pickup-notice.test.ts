import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PICKUP_NOTICE_ETA_HINT, pickupNotice, pickupScheduleOf } from './pickup-notice.ts'
import type { PickupScheduleInfo, ShippingOption } from '../types/models.ts'

const schedule = (reason: PickupScheduleInfo['reason'], over: Partial<PickupScheduleInfo> = {}): PickupScheduleInfo => ({
  reason,
  pickupAt: '2026-11-09T10:00:00.000Z',
  timeZone: 'Asia/Jakarta',
  cutoffTime: '15:00',
  pickupTime: '17:00',
  ...over,
})

const opt = (over: Partial<ShippingOption>): ShippingOption => ({
  provider: 'jne', service: 'REG', serviceName: 'JNE Reguler', estimatedDays: '1-2 Days', shippingCost: 9000, ...over,
})

test('Friday at/after the cut-off: Monday, worded around PAYMENT verification at 15.00 WIB', () => {
  const text = pickupNotice([opt({ pickupSchedule: schedule('MONDAY_AFTER_FRIDAY_CUTOFF') })])
  assert.equal(
    text,
    'Pesanan yang pembayarannya terverifikasi setelah pukul 15.00 WIB pada hari Jumat dijadwalkan untuk diserahkan kepada kurir pada hari Senin.',
  )
})

test('weekend: Monday, worded around PAYMENT verification', () => {
  assert.equal(
    pickupNotice([opt({ pickupSchedule: schedule('MONDAY_AFTER_WEEKEND') })]),
    'Pesanan yang pembayarannya terverifikasi pada akhir pekan dijadwalkan untuk diserahkan kepada kurir pada hari Senin.',
  )
})

test('ordinary same-day and next-day pickups add no notice', () => {
  assert.equal(pickupNotice([opt({ pickupSchedule: schedule('SAME_DAY') })]), null)
  assert.equal(pickupNotice([opt({ pickupSchedule: schedule('NEXT_DAY') })]), null)
})

test('no schedule from the backend (older API, no options) means no notice', () => {
  assert.equal(pickupNotice([]), null)
  assert.equal(pickupNotice([opt({})]), null)
})

test('one notice for the whole list, whatever the number of couriers', () => {
  const s = schedule('MONDAY_AFTER_WEEKEND')
  const options = [
    opt({ pickupSchedule: s }),
    opt({ service: 'YES', pickupSchedule: s }),
    opt({ provider: 'paxel', service: 'PAXEL_REGULAR', pickupSchedule: s }),
  ]
  assert.equal(pickupScheduleOf(options), s)
  assert.equal(typeof pickupNotice(options), 'string')
})

test('the cut-off shown follows the backend policy, not a hard-coded hour', () => {
  const text = pickupNotice([opt({ pickupSchedule: schedule('MONDAY_AFTER_FRIDAY_CUTOFF', { cutoffTime: '14:30' }) })])
  assert.match(text ?? '', /pukul 14\.30 WIB/)
})

test('never promises a delivery or arrival, only the hand-over to the courier', () => {
  for (const reason of ['MONDAY_AFTER_FRIDAY_CUTOFF', 'MONDAY_AFTER_WEEKEND'] as const) {
    const text = pickupNotice([opt({ pickupSchedule: schedule(reason) })]) ?? ''
    assert.match(text, /diserahkan kepada kurir/)
    assert.doesNotMatch(text, /tiba|sampai|diterima|dikirim ke alamat|estimasi/i)
    assert.match(text, /pembayarannya terverifikasi/)
  }
  assert.match(PICKUP_NOTICE_ETA_HINT, /sejak paket diserahkan kepada kurir/)
})
