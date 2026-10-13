import { isCode128BEncodable } from '../barcode/code128';

/**
 * P3 packing slip — PURE view helpers for the document page (no React, no fetch).
 * The backend already maps every field and fallback; these only decide what the
 * page renders around it.
 */

/** A barcode is drawn only for a real, exactly encodable AWB - never a substitute. */
export function barcodeValue(shipment: { trackingNumber: string | null }): string | null {
  return isCode128BEncodable(shipment.trackingNumber) ? shipment.trackingNumber : null;
}

export type PackingSlipErrorKind = 'forbidden' | 'not-found' | 'other';

export function packingSlipErrorKind(error: unknown): PackingSlipErrorKind {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'other';
}

export const PACKING_SLIP_ERROR_MESSAGE: Record<PackingSlipErrorKind, string> = {
  forbidden: 'Anda tidak memiliki izin untuk melihat packing slip ini.',
  'not-found': 'Order tidak ditemukan.',
  other: 'Tidak dapat memuat packing slip',
};

/** The route the Order Detail opens in a new tab. */
export function packingSlipPath(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}/packing-slip`;
}
