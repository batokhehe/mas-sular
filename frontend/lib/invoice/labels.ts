/** P2 #14: customer-facing (Indonesian) labels for the invoice page. Unknown values fall back to the raw code. */

const ORDER_STATUS: Record<string, string> = {
  PENDING: 'Menunggu pembayaran',
  PROCESSING: 'Diproses',
  PACKING: 'Dikemas',
  SHIPPED: 'Dikirim',
  DELIVERING: 'Sedang diantar',
  DELIVERED: 'Diterima',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
}

const PAYMENT_STATUS: Record<string, string> = {
  PENDING: 'Belum dibayar',
  WAITING_VERIFICATION: 'Menunggu verifikasi',
  PAID: 'Lunas',
  FAILED: 'Gagal',
  EXPIRED: 'Kedaluwarsa',
  REFUNDED: 'Dikembalikan',
}

const PAYMENT_METHOD: Record<string, string> = {
  BANK_TRANSFER: 'Transfer bank',
  QRIS: 'QRIS',
  GATEWAY: 'Pembayaran online',
  COD: 'Bayar di tempat (COD)',
}

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
}

const pick = (map: Record<string, string>, value: string | null | undefined) => (value ? (map[value] ?? value) : '-')

export const orderStatusLabel = (v: string | null | undefined) => pick(ORDER_STATUS, v)
export const paymentStatusLabel = (v: string | null | undefined) => pick(PAYMENT_STATUS, v)
export const paymentMethodLabel = (v: string | null | undefined) => pick(PAYMENT_METHOD, v)
export const shipmentStatusLabel = (v: string | null | undefined) => pick(SHIPMENT_STATUS, v)
