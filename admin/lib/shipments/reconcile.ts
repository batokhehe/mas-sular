/**
 * Admin "Rekonsiliasi pengiriman" (POST /admin/orders/:orderId/shipment/reconcile).
 *
 * An UNKNOWN shipment without an airwaybill means the courier MAY already hold a
 * booking (the answer was ambiguous, or it accepted but the booking could not be
 * recorded). It is resolved only here - never by editing the shipment status -
 * after the operator checked with the courier:
 *
 *  - booked:     the courier has it -> record that AWB (the order ships).
 *  - not_booked: the courier confirmed there is no active booking -> booking reopens.
 *                Needs the courier's confirmation reference; if the courier is known to
 *                have issued an AWB, it must be cancelled with the courier first.
 *
 * The server enforces every rule below (and more: the integration-log check and the
 * in-flight lease). This module only mirrors them so the form can say what is missing
 * before sending. Pure: no React, no fetch.
 */

/** Same pattern the server applies to an AWB (JNE digits, Paxel `CO.MERCHANT-YYYYMMDD-N-XXXX`). */
export const AWB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export type ReconcileShipmentInput =
  | { outcome: 'booked'; trackingNumber: string; providerShipmentId?: string; note?: string }
  | { outcome: 'not_booked'; confirmNoActiveBooking: true; courierCheckReference: string; cancelledAtCourier?: boolean; note?: string };

export type ReconcileForm = {
  outcome: 'booked' | 'not_booked' | '';
  trackingNumber: string;
  providerShipmentId: string;
  confirmNoActiveBooking: boolean;
  courierCheckReference: string;
  cancelledAtCourier: boolean;
  note: string;
};

export const EMPTY_RECONCILE_FORM: ReconcileForm = {
  outcome: '',
  trackingNumber: '',
  providerShipmentId: '',
  confirmNoActiveBooking: false,
  courierCheckReference: '',
  cancelledAtCourier: false,
  note: '',
};

export type ReconcilableShipment = {
  status: string;
  trackingNumber?: string | null;
  metadata?: unknown;
};

/** True for the shipments only reconciliation may resolve (no Retry, no status edit). */
export function needsReconciliation(shipment: ReconcilableShipment | null | undefined): boolean {
  return !!shipment && shipment.status === 'UNKNOWN' && !shipment.trackingNumber;
}

export type CapturedAwb = { trackingNumber: string; provider: string | null };

/** The AWB the courier issued that could not be recorded (metadata.booking.unrecorded), if any. */
export function capturedAwb(metadata: unknown): CapturedAwb | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const booking = (metadata as { booking?: unknown }).booking;
  if (!booking || typeof booking !== 'object') return null;
  const unrecorded = (booking as { unrecorded?: unknown }).unrecorded;
  if (!unrecorded || typeof unrecorded !== 'object') return null;
  const { trackingNumber, provider } = unrecorded as { trackingNumber?: unknown; provider?: unknown };
  if (typeof trackingNumber !== 'string' || !trackingNumber) return null;
  return { trackingNumber, provider: typeof provider === 'string' ? provider : null };
}

export type ReconcileValidation = { ok: true; payload: ReconcileShipmentInput } | { ok: false; errors: string[] };

/** Client-side mirror of the server rules; returns the request body when complete. */
export function buildReconcilePayload(form: ReconcileForm, captured: CapturedAwb | null): ReconcileValidation {
  const note = form.note.trim() ? form.note.trim().slice(0, 500) : undefined;
  if (form.outcome === 'booked') {
    const trackingNumber = form.trackingNumber.trim();
    const errors: string[] = [];
    if (!AWB_PATTERN.test(trackingNumber)) errors.push('Masukkan AWB yang valid (3-64 huruf, angka, ".", "_" atau "-").');
    else if (captured && captured.trackingNumber !== trackingNumber) {
      errors.push(`Kurir sudah menerbitkan AWB ${captured.trackingNumber} untuk pengiriman ini; catat AWB tersebut.`);
    }
    if (errors.length) return { ok: false, errors };
    const providerShipmentId = form.providerShipmentId.trim() || undefined;
    return { ok: true, payload: { outcome: 'booked', trackingNumber, ...(providerShipmentId ? { providerShipmentId } : {}), ...(note ? { note } : {}) } };
  }
  if (form.outcome === 'not_booked') {
    const reference = form.courierCheckReference.trim();
    const errors: string[] = [];
    if (!form.confirmNoActiveBooking) errors.push('Konfirmasi bahwa kurir menyatakan tidak ada booking aktif untuk pesanan ini.');
    if (reference.length < 3) errors.push('Isi referensi konfirmasi kurir (nomor tiket CS, ID kasus, atau referensi portal), minimal 3 karakter.');
    if (reference.length > 200) errors.push('Referensi konfirmasi kurir maksimal 200 karakter.');
    if (captured && !form.cancelledAtCourier) {
      errors.push(`AWB ${captured.trackingNumber} sudah diterbitkan kurir. Batalkan AWB tersebut ke kurir terlebih dahulu, lalu centang konfirmasi pembatalan.`);
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      payload: {
        outcome: 'not_booked',
        confirmNoActiveBooking: true,
        courierCheckReference: reference,
        ...(form.cancelledAtCourier ? { cancelledAtCourier: true } : {}),
        ...(note ? { note } : {}),
      },
    };
  }
  return { ok: false, errors: ['Pilih hasil pengecekan ke kurir.'] };
}

/** Operator guidance shown with the action (Indonesian, like the rest of the admin). */
export const RECONCILE_GUIDANCE = {
  title: 'Hasil booking kurir tidak pasti',
  intro:
    'Kurir mungkin sudah menerima booking untuk pesanan ini. Jangan buat booking ulang dan jangan ubah status pengiriman secara manual. ' +
    'Cek ke kurir terlebih dahulu, lalu catat hasilnya di sini.',
  booked: 'Kurir punya booking untuk pesanan ini: catat AWB-nya. Pesanan akan berstatus Dikirim.',
  notBooked:
    'Kurir mengonfirmasi tidak ada booking aktif: pengiriman bisa dicoba ulang. Wajib menyertakan referensi konfirmasi dari kurir. ' +
    'Timeout atau tidak adanya AWB BUKAN bukti bahwa booking tidak dibuat.',
  cancelFirst: (awb: string) =>
    `Kurir sudah menerbitkan AWB ${awb}. Jika booking tersebut tidak dipakai, batalkan AWB ${awb} ke kurir terlebih dahulu sebelum memilih "Tidak ada booking".`,
  serverMayRequireCancel:
    'Jika log integrasi menunjukkan kurir pernah menerima booking untuk pesanan ini, sistem juga akan meminta konfirmasi pembatalan ke kurir.',
} as const;
