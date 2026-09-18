/**
 * Indonesian display labels for business statuses. Presentation only: the enum
 * values sent to and received from the API never change. The wording matches the
 * storefront (frontend/lib/invoice/labels.ts) so customers and operators see the
 * same terms. A value this build does not know is shown as-is.
 *
 * System/ops screens (queues, notification send status, incidents, log levels,
 * integration outcomes) keep their raw technical codes on purpose.
 */

const ORDER_STATUS: Record<string, string> = {
  PENDING: 'Menunggu pembayaran',
  PROCESSING: 'Diproses',
  PACKING: 'Dikemas',
  SHIPPED: 'Dikirim',
  DELIVERING: 'Sedang diantar',
  DELIVERED: 'Diterima',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

const PAYMENT_STATUS: Record<string, string> = {
  PENDING: 'Belum dibayar',
  WAITING_VERIFICATION: 'Menunggu verifikasi',
  PAID: 'Lunas',
  FAILED: 'Gagal',
  EXPIRED: 'Kedaluwarsa',
  REFUNDED: 'Dikembalikan',
};

const PAYMENT_METHOD: Record<string, string> = {
  BANK_TRANSFER: 'Transfer bank',
  QRIS: 'QRIS',
  GATEWAY: 'Pembayaran online',
  COD: 'Bayar di tempat (COD)',
};

const SHIPMENT_STATUS: Record<string, string> = {
  PENDING: 'Menunggu',
  RATE_SELECTED: 'Menunggu pengiriman',
  CREATED: 'Pengiriman dibuat',
  WAITING_PICKUP: 'Menunggu dijemput kurir',
  PICKED_UP: 'Dijemput kurir',
  IN_TRANSIT: 'Dalam perjalanan',
  OUT_FOR_DELIVERY: 'Sedang diantar',
  DELIVERED: 'Terkirim',
  FAILED: 'Gagal dikirim',
  CANCELLED: 'Dibatalkan',
  UNKNOWN: 'Tidak diketahui',
};

const PRODUCT_STATUS: Record<string, string> = {
  DRAFT: 'Draf',
  ACTIVE: 'Aktif',
  ARCHIVED: 'Diarsipkan',
};

const RESERVATION_STATUS: Record<string, string> = {
  RESERVED: 'Direservasi',
  COMMITTED: 'Terkonfirmasi',
  RELEASED: 'Dilepas',
  EXPIRED: 'Kedaluwarsa',
  CANCELLED: 'Dibatalkan',
};

const STOCK_TRANSFER_STATUS: Record<string, string> = {
  REQUESTED: 'Diajukan',
  APPROVED: 'Disetujui',
  COMPLETED: 'Selesai',
  REJECTED: 'Ditolak',
  CANCELLED: 'Dibatalkan',
};

const pick = (map: Record<string, string>, value: string | null | undefined) =>
  value ? (Object.hasOwn(map, value) ? map[value] : value) : '—';

export const orderStatusLabel = (value: string | null | undefined) => pick(ORDER_STATUS, value);
export const paymentStatusLabel = (value: string | null | undefined) => pick(PAYMENT_STATUS, value);
export const paymentMethodLabel = (value: string | null | undefined) => pick(PAYMENT_METHOD, value);
export const shipmentStatusLabel = (value: string | null | undefined) => pick(SHIPMENT_STATUS, value);
export const productStatusLabel = (value: string | null | undefined) => pick(PRODUCT_STATUS, value);
export const reservationStatusLabel = (value: string | null | undefined) => pick(RESERVATION_STATUS, value);
export const stockTransferStatusLabel = (value: string | null | undefined) => pick(STOCK_TRANSFER_STATUS, value);
