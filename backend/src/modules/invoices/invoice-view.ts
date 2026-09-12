import { PaymentMethod, Prisma } from '@prisma/client';

/**
 * P2 #14: the ONLY order data the public invoice page receives.
 *
 * The query selects exactly these columns (INVOICE_ORDER_SELECT) and the mapper
 * builds the response field by field, so nothing reaches the customer merely
 * because it exists on the order: no database ids, no user id/email, no
 * coordinates, no voucher/outlet/coverage ids, no internal notes, reservations,
 * receipt URL, verifier, gateway or courier payloads.
 */
export const INVOICE_ORDER_SELECT = {
  orderNumber: true,
  status: true,
  createdAt: true,
  deletedAt: true,
  subtotal: true,
  voucherCode: true,
  voucherDiscountAmount: true,
  deliveryFee: true,
  paymentServiceFee: true,
  totalPrice: true,
  paymentMethod: true,
  shippingProvider: true,
  shippingService: true,
  shippingServiceName: true,
  trackingNumber: true,
  items: {
    select: {
      productName: true,
      unitPrice: true,
      quantity: true,
      spicyLevel: true,
      notes: true,
      toppings: { select: { name: true, price: true } },
    },
    orderBy: { productName: 'asc' },
  },
  address: {
    select: {
      recipientName: true,
      phone: true,
      fullAddress: true,
      addressDetail: true,
      postalCode: true,
      village: { select: { name: true } },
      district: { select: { name: true } },
      city: { select: { name: true } },
      province: { select: { name: true } },
    },
  },
  payment: { select: { method: true, status: true, amount: true, uniqueCode: true } },
  shipment: { select: { provider: true, service: true, status: true, trackingNumber: true } },
} satisfies Prisma.OrderSelect;

export type InvoiceOrderRow = Prisma.OrderGetPayload<{ select: typeof INVOICE_ORDER_SELECT }>;

export interface CustomerInvoice {
  store: { name: string };
  orderNumber: string;
  orderDate: string;
  orderStatus: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    toppings: Array<{ name: string; price: number }>;
    spicyLevel: number | null;
    notes: string | null;
    lineTotal: number;
  }>;
  subtotal: number;
  discount: number;
  voucherCode: string | null;
  shippingCost: number;
  /** Customer-charged "Biaya Layanan" only — never the merchant-absorbed share. */
  paymentServiceFee: number;
  /** Gateway orders show the "Biaya Layanan" row even at Rp0 (fee absorbed by the merchant). */
  paymentServiceFeeApplies: boolean;
  total: number;
  payment: {
    method: string;
    status: string | null;
    /** What the customer transfers (includes the manual unique code); the same backend value checkout shows. */
    amountDue: number;
    /** Manual bank transfer only. */
    uniqueCode: number | null;
  };
  shipping: { courier: string | null; service: string | null; status: string | null; trackingNumber: string | null };
  delivery: { recipientName: string; phone: string; address: string };
}

const COURIER_LABELS: Record<string, string> = { paxel: 'Paxel', jne: 'JNE' };

/** Keep the first 4 and last 3 digits: enough for the customer to recognise the number, not to reuse it. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return digits ? '*'.repeat(digits.length) : '';
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 7)}${digits.slice(-3)}`;
}

export function toCustomerInvoice(order: InvoiceOrderRow): CustomerInvoice {
  const a = order.address;
  const street = a.addressDetail?.trim() || a.fullAddress;
  const address = [
    street,
    a.village?.name ? `Kel. ${a.village.name}` : null,
    a.district?.name ? `Kec. ${a.district.name}` : null,
    a.city?.name ?? null,
    a.province?.name ?? null,
    a.postalCode ?? null,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(', ');

  const method = order.payment?.method ?? order.paymentMethod;
  const provider = order.shipment?.provider ?? order.shippingProvider;

  return {
    store: { name: 'Bakso Mas Sular' },
    orderNumber: order.orderNumber,
    orderDate: order.createdAt.toISOString(),
    orderStatus: order.status,
    items: order.items.map((item) => {
      const toppings = item.toppings.map((t) => ({ name: t.name, price: t.price }));
      const toppingTotal = toppings.reduce((sum, t) => sum + t.price, 0);
      return {
        name: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        toppings,
        spicyLevel: item.spicyLevel ?? null,
        notes: item.notes ?? null,
        // Same per-line pricing checkout uses: (unit + toppings) x quantity.
        lineTotal: (item.unitPrice + toppingTotal) * item.quantity,
      };
    }),
    subtotal: order.subtotal,
    discount: order.voucherDiscountAmount,
    voucherCode: order.voucherCode ?? null,
    shippingCost: order.deliveryFee,
    paymentServiceFee: order.paymentServiceFee,
    paymentServiceFeeApplies: method === 'GATEWAY',
    total: order.totalPrice,
    payment: {
      method,
      status: order.payment?.status ?? null,
      amountDue: order.payment?.amount ?? order.totalPrice,
      uniqueCode: method === PaymentMethod.BANK_TRANSFER ? (order.payment?.uniqueCode ?? null) : null,
    },
    shipping: {
      courier: provider ? (COURIER_LABELS[provider.toLowerCase()] ?? provider) : null,
      service: order.shippingServiceName ?? order.shipment?.service ?? order.shippingService ?? null,
      status: order.shipment?.status ?? null,
      trackingNumber: order.shipment?.trackingNumber ?? order.trackingNumber ?? null,
    },
    delivery: { recipientName: a.recipientName, phone: maskPhone(a.phone), address },
  };
}
