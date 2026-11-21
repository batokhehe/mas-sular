import { Prisma, ShipmentStatus } from '@prisma/client';
import { readShipmentMetadata } from './shipment-metadata';

/**
 * Shipments that only the booking/reconciliation workflow may change.
 *
 *  - `reconciliation`: UNKNOWN without an airwaybill. The courier may hold a booking.
 *    Only ShipmentService.reconcileBooking - which demands courier evidence and checks
 *    any captured AWB - may resolve it. A generic edit to FAILED / RATE_SELECTED would
 *    reopen booking without evidence; a generic AWB edit would skip the captured-AWB
 *    match and the order's SHIPPED transition.
 *  - `booking_in_progress`: PENDING with a booking owner (bookingAttemptId). Its owner
 *    may be at the courier right now. Resetting it would release the claim to another
 *    caller - a second courier booking.
 *
 * A shipment with an airwaybill is never locked here: tracking and the booked-shipment
 * guards in AdminService.updateShipment govern it.
 */
export type BookingRecoveryLock = 'reconciliation' | 'booking_in_progress';

export function bookingRecoveryLock(shipment: {
  status: ShipmentStatus | string;
  trackingNumber?: string | null;
  bookingAttemptId?: string | null;
}): BookingRecoveryLock | null {
  if (shipment.trackingNumber) return null;
  if (shipment.status === ShipmentStatus.UNKNOWN) return 'reconciliation';
  if (shipment.status === ShipmentStatus.PENDING && shipment.bookingAttemptId) return 'booking_in_progress';
  return null;
}

export function bookingRecoveryLockMessage(lock: BookingRecoveryLock, orderId: string): string {
  return lock === 'reconciliation'
    ? 'This shipment is awaiting courier reconciliation (the courier may already hold a booking). ' +
        `Resolve it with POST /admin/orders/${orderId}/shipment/reconcile, not a generic edit.`
    : 'A courier booking attempt owns this shipment and may be at the courier right now. ' +
        'It cannot be edited or deleted until the attempt finishes (or is parked for reconciliation).';
}

/**
 * True when the shipment carries evidence that a courier issued an AWB this system
 * could not record (metadata.booking.unrecorded). That record is the only trace of a
 * possibly-live courier booking and must never be destroyed by a delete.
 */
export function hasUnrecordedBookingEvidence(metadata: Prisma.JsonValue | null | undefined): boolean {
  return Boolean(readShipmentMetadata(metadata).booking?.unrecorded);
}
