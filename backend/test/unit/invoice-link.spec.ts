import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PaymentMethod } from '@prisma/client';
import { INVOICE_LINK_TTL_MS, INVOICE_TOKEN_SHAPE, InvoiceTokenService } from '../../src/modules/invoices/invoice-token.service';
import { INVOICE_LINK_UNAVAILABLE, InvoiceService } from '../../src/modules/invoices/invoice.service';
import { InvoicesController } from '../../src/modules/invoices/invoices.controller';
import { INVOICE_ORDER_SELECT, InvoiceOrderRow, maskPhone, toCustomerInvoice } from '../../src/modules/invoices/invoice-view';

/**
 * P2 #14 — customer invoice links: token lifecycle, the public invoice read, and
 * the customer-safe view. Real PostgreSQL behaviour (hash lookup, rotation,
 * cross-order isolation) is in test/integration/invoice-link.int-spec.ts.
 */

const NOW = 1_800_000_000_000;
const BASE = 'https://shop.example';

function tokenService(prisma: unknown = {}) {
  const s = new InvoiceTokenService(prisma as never);
  (s as unknown as { nowMs: () => number }).nowMs = () => NOW;
  return s;
}

beforeEach(() => {
  process.env.PAYMENT_UPLOAD_BASE_URL = BASE;
});

describe('InvoiceTokenService.issue', () => {
  const prismaWith = () => {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tok-1', createdAt: new Date(NOW), ...data }));
    return { create, prisma: { orderInvoiceToken: { create } } };
  };

  it('1/2. returns a 256-bit hex secret once and stores ONLY its SHA-256 hash, for 30 days', async () => {
    const { create, prisma } = prismaWith();
    const s = tokenService(prisma);
    const issued = await s.issue('order-A', 'admin-1');
    const stored = create.mock.calls[0][0].data;

    expect(issued.rawToken).toMatch(INVOICE_TOKEN_SHAPE);
    expect(stored.tokenHash).toBe(s.hash(issued.rawToken));
    expect(stored.tokenHash).not.toBe(issued.rawToken);
    expect(JSON.stringify(create.mock.calls)).not.toContain(issued.rawToken); // raw secret never persisted
    expect(stored).toMatchObject({ orderId: 'order-A', createdById: 'admin-1' });
    expect(stored.expiresAt.getTime()).toBe(NOW + INVOICE_LINK_TTL_MS);
    expect(INVOICE_LINK_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(issued.invoiceUrl).toBe(`${BASE}/invoice/${issued.rawToken}`);
  });

  it('1. credentials are unpredictable: 500 issues are all distinct and share no structure', async () => {
    const s = tokenService(prismaWith().prisma);
    const tokens = await Promise.all(Array.from({ length: 500 }, () => s.issue('order-A', null).then((i) => i.rawToken)));
    expect(new Set(tokens).size).toBe(500);
    expect(new Set(tokens.map((t) => t.slice(0, 6))).size).toBeGreaterThan(450); // no shared prefix/counter
    for (const t of tokens) {
      expect(t).not.toContain('order-A'); // never derived from the order
    }
  });

  it('refuses to issue (and writes nothing) when the storefront origin is not configured', async () => {
    delete process.env.PAYMENT_UPLOAD_BASE_URL;
    const { create, prisma } = prismaWith();
    await expect(tokenService(prisma).issue('order-A', null)).rejects.toThrow(/PAYMENT_UPLOAD_BASE_URL/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('InvoiceTokenService.resolveOrderId', () => {
  const raw = 'a'.repeat(64);
  const withRow = (row: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(row);
    return { findUnique, s: tokenService({ orderInvoiceToken: { findUnique } }) };
  };

  it('3. a valid, unrevoked, unexpired token resolves to exactly its order (looked up by hash)', async () => {
    const { findUnique, s } = withRow({ orderId: 'order-A', revokedAt: null, expiresAt: new Date(NOW + 1000) });
    expect(await s.resolveOrderId(raw)).toBe('order-A');
    expect(findUnique.mock.calls[0][0].where).toEqual({ tokenHash: s.hash(raw) });
  });

  it('4. unknown token -> null', async () => {
    expect(await withRow(null).s.resolveOrderId(raw)).toBeNull();
  });

  it('5. expired token -> null (expiry is exclusive)', async () => {
    expect(await withRow({ orderId: 'o', revokedAt: null, expiresAt: new Date(NOW) }).s.resolveOrderId(raw)).toBeNull();
    expect(await withRow({ orderId: 'o', revokedAt: null, expiresAt: new Date(NOW - 1) }).s.resolveOrderId(raw)).toBeNull();
  });

  it('revoked token -> null', async () => {
    expect(await withRow({ orderId: 'o', revokedAt: new Date(NOW - 1), expiresAt: new Date(NOW + 1000) }).s.resolveOrderId(raw)).toBeNull();
  });

  it('7. malformed tokens are rejected WITHOUT touching the database', async () => {
    const { findUnique, s } = withRow({ orderId: 'o', revokedAt: null, expiresAt: new Date(NOW + 1000) });
    for (const bad of ['', 'abc', 'A'.repeat(64), `${raw}0`, `${raw.slice(1)}g`, '../../etc/passwd', `${raw.slice(0, 32)}%20`, '5f0e3c8b-order-uuid']) {
      expect(await s.resolveOrderId(bad)).toBeNull();
    }
    expect(await s.resolveOrderId(undefined as unknown as string)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('InvoiceTokenService rotation helpers', () => {
  it('revokeOthers revokes every other ACTIVE link of that order only', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const s = tokenService({ orderInvoiceToken: { updateMany } });
    await s.revokeOthers('order-A', 'keep-me');
    expect(updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-A', id: { not: 'keep-me' }, revokedAt: null },
      data: { revokedAt: new Date(NOW) },
    });
  });

  it('discard deletes exactly the unsent link', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    await tokenService({ orderInvoiceToken: { deleteMany } }).discard('tok-9');
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'tok-9' } });
  });
});

// ------------------------------------------------------------ customer view ---

function order(over: Partial<InvoiceOrderRow> = {}): InvoiceOrderRow {
  return {
    orderNumber: 'BMS-20260911-ABCD',
    status: 'PROCESSING',
    createdAt: new Date('2026-09-11T03:00:00.000Z'),
    deletedAt: null,
    subtotal: 45000 * 2 + (8000 + 5000) * 3,
    voucherCode: 'HEMAT10',
    voucherDiscountAmount: 10000,
    deliveryFee: 20000,
    paymentServiceFee: 0,
    totalPrice: 45000 * 2 + 13000 * 3 - 10000 + 20000,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    shippingProvider: 'paxel',
    shippingService: 'PAXEL_NEXTDAY',
    shippingServiceName: 'Paxel Next Day',
    trackingNumber: null,
    items: [
      { productName: 'Baso Urat Jumbo', unitPrice: 45000, quantity: 2, spicyLevel: null, notes: null, toppings: [] },
      { productName: 'Es Teh Manis', unitPrice: 8000, quantity: 3, spicyLevel: 2, notes: 'Tanpa es', toppings: [{ name: 'Mie Kuning', price: 5000 }] },
    ],
    address: {
      recipientName: 'Budi',
      phone: '6281234567890',
      fullAddress: 'Jl. Contoh No. 1',
      addressDetail: 'Jl. Contoh No. 1 RT 01/RW 02',
      postalCode: '40286',
      village: { name: 'Margasari' },
      district: { name: 'Buahbatu' },
      city: { name: 'Kota Bandung' },
      province: { name: 'Jawa Barat' },
    },
    payment: { method: PaymentMethod.BANK_TRANSFER, status: 'PENDING', amount: 999999, uniqueCode: 123 },
    shipment: { provider: 'paxel', service: 'Paxel Next Day', status: 'IN_TRANSIT', trackingNumber: 'PXL-123' },
    ...over,
  } as InvoiceOrderRow;
}

describe('toCustomerInvoice', () => {
  it('11/12. items with quantities, unit prices and (unit + toppings) x qty line totals', () => {
    const inv = toCustomerInvoice(order());
    expect(inv.items).toEqual([
      { name: 'Baso Urat Jumbo', quantity: 2, unitPrice: 45000, toppings: [], spicyLevel: null, notes: null, lineTotal: 90000 },
      { name: 'Es Teh Manis', quantity: 3, unitPrice: 8000, toppings: [{ name: 'Mie Kuning', price: 5000 }], spicyLevel: 2, notes: 'Tanpa es', lineTotal: 39000 },
    ]);
  });

  it('13. subtotal / discount / shipping / total are the order\'s own stored values', () => {
    const inv = toCustomerInvoice(order());
    expect(inv).toMatchObject({ subtotal: 129000, discount: 10000, voucherCode: 'HEMAT10', shippingCost: 20000, paymentServiceFee: 0, total: 139000 });
    expect(inv.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(inv.subtotal);
  });

  it('14. payment: method, status, the backend amount due; unique code only for manual bank transfer', () => {
    expect(toCustomerInvoice(order()).payment).toEqual({ method: 'BANK_TRANSFER', status: 'PENDING', amountDue: 999999, uniqueCode: 123 });
    const gateway = toCustomerInvoice(order({ paymentMethod: PaymentMethod.GATEWAY, payment: { method: PaymentMethod.GATEWAY, status: 'PAID', amount: 139000, uniqueCode: 7 } as never }));
    expect(gateway.payment).toEqual({ method: 'GATEWAY', status: 'PAID', amountDue: 139000, uniqueCode: null });
  });

  it('shipping: courier label, service, status and AWB (customer-facing, as in the WhatsApp shipped message)', () => {
    expect(toCustomerInvoice(order()).shipping).toEqual({ courier: 'Paxel', service: 'Paxel Next Day', status: 'IN_TRANSIT', trackingNumber: 'PXL-123' });
  });

  it('15. delivery: recipient, masked phone, readable address only', () => {
    expect(toCustomerInvoice(order()).delivery).toEqual({
      recipientName: 'Budi',
      phone: '6281******890',
      address: 'Jl. Contoh No. 1 RT 01/RW 02, Kel. Margasari, Kec. Buahbatu, Kota Bandung, Jawa Barat, 40286',
    });
    expect(maskPhone('6281234567890')).toBe('6281******890');
    expect(maskPhone('0812-3456-7890')).toBe('0812*****890'); // 12 digits: 4 shown, 5 masked, 3 shown
    expect(maskPhone(null)).toBe('');
  });

  it('10. exposes no ids, emails, coordinates or internal fields - exactly the allowed keys', () => {
    const inv = toCustomerInvoice(order());
    expect(Object.keys(inv).sort()).toEqual(
      ['delivery', 'discount', 'items', 'orderDate', 'orderNumber', 'orderStatus', 'payment', 'paymentServiceFee', 'paymentServiceFeeApplies', 'shipping', 'shippingCost', 'store', 'subtotal', 'total', 'voucherCode'].sort(),
    );
    const json = JSON.stringify(inv);
    // The merchant's absorbed/calculated fee and the fee rule are internal accounting, never customer-facing.
    for (const forbidden of ['"id"', 'userId', 'addressId', 'orderId', 'productId', 'email', 'latitude', 'longitude', 'outletId', 'coverageId', 'voucherId', 'manualReceiptUrl', 'verifiedBy', 'providerReference', 'webhookPayload', 'shippingPayload', 'providerPayload', 'internalNotes', 'reservations', 'sku', '6281234567890', 'Absorbed', 'Calculated', 'paymentServiceFeeRule', 'passThrough']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('service fee: a gateway order shows the "Biaya Layanan" row even at Rp0; manual transfer does not', () => {
    const absorbed = toCustomerInvoice(order({
      paymentMethod: PaymentMethod.GATEWAY, paymentServiceFee: 0,
      payment: { method: PaymentMethod.GATEWAY, status: 'PENDING', amount: 105000, uniqueCode: null } as never,
    }));
    expect(absorbed).toMatchObject({ paymentServiceFee: 0, paymentServiceFeeApplies: true });
    const charged = toCustomerInvoice(order({
      paymentMethod: PaymentMethod.GATEWAY, paymentServiceFee: 4000,
      payment: { method: PaymentMethod.GATEWAY, status: 'PENDING', amount: 109000, uniqueCode: null } as never,
    }));
    expect(charged).toMatchObject({ paymentServiceFee: 4000, paymentServiceFeeApplies: true });
    expect(toCustomerInvoice(order())).toMatchObject({ paymentServiceFeeApplies: false });
  });

  it('the database select itself asks only for those columns (no ids, no user, no email, no coordinates)', () => {
    const select = JSON.stringify(INVOICE_ORDER_SELECT);
    for (const forbidden of ['"id"', 'userId', 'user', 'email', 'latitude', 'longitude', 'internalNotes', 'reservations', 'manualReceiptUrl', 'webhookPayload', 'shippingPayload', 'providerPayload', 'metadata', 'paymentServiceFeeAbsorbed', 'paymentServiceFeeCalculated', 'paymentServiceFeeRule']) {
      expect(select).not.toContain(forbidden);
    }
  });
});

// ------------------------------------------------------------ public read ---

describe('InvoiceService.getByToken / InvoicesController', () => {
  const build = (orderId: string | null, row: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(row);
    const tokens = { resolveOrderId: jest.fn().mockResolvedValue(orderId) };
    return { findUnique, tokens, svc: new InvoiceService({ order: { findUnique } } as never, tokens as never) };
  };

  it('3/9. the order comes ONLY from the token - nothing in the request can point at another order', async () => {
    const { findUnique, svc } = build('order-A', order());
    const inv = await svc.getByToken('a'.repeat(64));
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'order-A' }, select: INVOICE_ORDER_SELECT });
    expect(inv.orderNumber).toBe('BMS-20260911-ABCD');
    expect(InvoiceService.prototype.getByToken.length).toBe(1); // no order-id parameter exists
  });

  it('4/5/7. invalid, expired or malformed tokens and deleted orders are the same 404', async () => {
    for (const { orderId, row } of [
      { orderId: null, row: order() },
      { orderId: 'order-A', row: null },
      { orderId: 'order-A', row: order({ deletedAt: new Date() }) },
    ]) {
      const err = await build(orderId, row).svc.getByToken('x').catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe(INVOICE_LINK_UNAVAILABLE);
    }
  });

  it('8. the public route has no auth guard, and forbids caching / referrer leaks', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InvoicesController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, InvoicesController.prototype.getInvoice)).toBeUndefined();
    const headers = Reflect.getMetadata('__headers__', InvoicesController.prototype.getInvoice) as Array<{ name: string; value: string }>;
    expect(headers).toEqual(expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }, { name: 'Referrer-Policy', value: 'no-referrer' }]));
  });
});
