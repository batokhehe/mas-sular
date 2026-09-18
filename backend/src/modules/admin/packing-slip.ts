import { Prisma, ShipmentStatus } from '@prisma/client';
import { BUSINESS_TIMEZONE, zonedCivil } from '../../common/utils/business-time.util';

/**
 * P3 Packing Slip — the read-only document an operator prints to pack an order.
 *
 * Pure: the narrow Prisma select and the mapper to a presentation-only view. It
 * carries exactly what the slip shows - no payment, notes, events, audit or
 * provider data. No prices: a packing slip is for packing.
 */

export const NOT_AVAILABLE = '—';
export const AWB_NOT_AVAILABLE = 'Belum tersedia';
export const NO_SHIPMENT = 'Belum ada pengiriman';

/** Indonesian display label per internal shipment status. */
export const SHIPMENT_STATUS_LABEL_ID: Readonly<Record<ShipmentStatus, string>> = {
  PENDING: 'Menunggu',
  RATE_SELECTED: 'Kurir dipilih',
  CREATED: 'Pengiriman dibuat',
  WAITING_PICKUP: 'Menunggu pickup',
  PICKED_UP: 'Sudah dipickup',
  IN_TRANSIT: 'Dalam perjalanan',
  OUT_FOR_DELIVERY: 'Sedang diantar',
  DELIVERED: 'Terkirim',
  FAILED: 'Gagal',
  CANCELLED: 'Dibatalkan',
  UNKNOWN: 'Status tidak diketahui',
};

/** Exactly the columns the slip reads. */
export const PACKING_SLIP_SELECT = {
  orderNumber: true,
  createdAt: true,
  deletedAt: true,
  outlet: { select: { name: true } },
  // Existing domain fallback (the Order Detail shows the allocated outlet this way).
  reservations: { select: { outlet: { select: { name: true } } }, orderBy: { createdAt: 'asc' }, take: 1 },
  address: {
    select: {
      recipientName: true,
      addressDetail: true,
      fullAddress: true,
      phone: true,
      postalCode: true,
      province: { select: { name: true } },
      city: { select: { name: true } },
      district: { select: { name: true } },
      village: { select: { name: true, postalCode: true } },
    },
  },
  items: {
    // Same order as the Order Detail page (OrderItem has no timestamp to sort by).
    select: { productName: true, quantity: true, toppings: { select: { name: true }, orderBy: { name: 'asc' } } },
  },
  shipment: { select: { trackingNumber: true, status: true } },
} satisfies Prisma.OrderSelect;

export type PackingSlipRow = Prisma.OrderGetPayload<{ select: typeof PACKING_SLIP_SELECT }>;

export interface PackingSlipView {
  orderNumber: string;
  /** Formatted in Asia/Jakarta, e.g. "17 September 2026, 10:05 WIB". */
  orderDate: string;
  outlet: string;
  recipient: {
    name: string;
    /** Address detail (or the legacy free-text address), as stored. */
    address: string;
    /** Present regions only, in order: Kel., Kec., city, province. Empty for legacy addresses. */
    regionLines: string[];
    postalCode: string;
    phone: string;
  };
  items: Array<{ no: number; productName: string; quantity: number; toppings: string[] }>;
  shipment: {
    /** Shipment.trackingNumber exactly as stored, or null. */
    trackingNumber: string | null;
    /** trackingNumber, or "Belum tersedia". */
    awbLabel: string;
    status: ShipmentStatus | null;
    statusLabel: string;
  };
}

const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Deterministic Indonesian date-time in the business timezone (not ICU-locale dependent). */
export function formatSlipDate(instant: Date): string {
  const c = zonedCivil(instant, BUSINESS_TIMEZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${c.day} ${MONTHS_ID[c.month - 1]} ${c.year}, ${pad(c.hour)}:${pad(c.minute)} WIB`;
}

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';
const orDash = (value: string | null | undefined) => (present(value) ? value : NOT_AVAILABLE);

export function toPackingSlipView(order: PackingSlipRow): PackingSlipView {
  const address = order.address;
  const regionLines = [
    present(address.village?.name) ? `Kel. ${address.village.name}` : null,
    present(address.district?.name) ? `Kec. ${address.district.name}` : null,
    present(address.city?.name) ? address.city.name : null,
    present(address.province?.name) ? address.province.name : null,
  ].filter((line): line is string => line !== null);

  const trackingNumber = present(order.shipment?.trackingNumber) ? (order.shipment?.trackingNumber as string) : null;
  const status = order.shipment?.status ?? null;

  return {
    orderNumber: order.orderNumber,
    orderDate: formatSlipDate(order.createdAt),
    outlet: orDash(order.outlet?.name ?? order.reservations[0]?.outlet?.name),
    recipient: {
      name: orDash(address.recipientName),
      address: orDash(present(address.addressDetail) ? address.addressDetail : address.fullAddress),
      regionLines,
      postalCode: orDash(present(address.postalCode) ? address.postalCode : address.village?.postalCode),
      phone: orDash(address.phone),
    },
    items: order.items.map((item, index) => ({
      no: index + 1,
      productName: item.productName,
      quantity: item.quantity,
      toppings: item.toppings.map((topping) => topping.name),
    })),
    shipment: {
      trackingNumber,
      awbLabel: trackingNumber ?? AWB_NOT_AVAILABLE,
      status,
      statusLabel: order.shipment ? (SHIPMENT_STATUS_LABEL_ID[order.shipment.status] ?? order.shipment.status) : NO_SHIPMENT,
    },
  };
}
