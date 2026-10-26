/**
 * Checkout copy for the courier PICKUP schedule. Pure view helper — no React, no
 * fetch, and no scheduling rule of its own: the backend resolves the schedule
 * with the same function that books the courier and sends only its outcome
 * (`ShippingOption.pickupSchedule.reason`). This file only words it.
 *
 * The backend evaluates the rule at QUOTE time, but the real pickup is fixed from
 * the moment the PAYMENT is verified, which can be later. Every sentence is
 * therefore stated in terms of payment verification, never "your order will be
 * picked up on Monday", and it speaks about handing the parcel to the courier —
 * never about delivery or arrival, which is the courier's own estimate.
 */
import type { PickupScheduleInfo, ShippingOption } from '@/lib/types/models'

/** "15:00" -> "15.00" (Indonesian time notation). */
function idTime(hhmm: string): string {
  return hhmm.replace(':', '.')
}

/** The zone abbreviation customers know; anything else is shown verbatim. */
function zoneLabel(timeZone: string): string {
  return timeZone === 'Asia/Jakarta' ? 'WIB' : timeZone
}

/**
 * The single schedule shown for these options. Every courier shares the shop's
 * pickup rule, so the first option that carries a schedule speaks for all.
 */
export function pickupScheduleOf(options: readonly ShippingOption[]): PickupScheduleInfo | null {
  return options.find((o) => o.pickupSchedule)?.pickupSchedule ?? null
}

/**
 * The checkout notice, or null when none is needed. Only the two cases where the
 * pickup moves to Monday are announced; an ordinary same-day/next-day pickup
 * keeps the checkout as it was.
 */
export function pickupNotice(options: readonly ShippingOption[]): string | null {
  const schedule = pickupScheduleOf(options)
  if (!schedule) return null
  switch (schedule.reason) {
    case 'MONDAY_AFTER_FRIDAY_CUTOFF':
      return (
        `Pesanan yang pembayarannya terverifikasi setelah pukul ${idTime(schedule.cutoffTime)} ` +
        `${zoneLabel(schedule.timeZone)} pada hari Jumat dijadwalkan untuk diserahkan kepada kurir pada hari Senin.`
      )
    case 'MONDAY_AFTER_WEEKEND':
      return 'Pesanan yang pembayarannya terverifikasi pada akhir pekan dijadwalkan untuk diserahkan kepada kurir pada hari Senin.'
    default:
      return null
  }
}

/** Shown under the notice so the courier estimate is never read as starting today. */
export const PICKUP_NOTICE_ETA_HINT = 'Estimasi pengiriman kurir dihitung sejak paket diserahkan kepada kurir.'
