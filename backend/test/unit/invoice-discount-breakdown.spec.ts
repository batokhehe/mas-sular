import { PaymentMethod } from '@prisma/client';
import { INVOICE_ORDER_SELECT, InvoiceOrderRow, toCustomerInvoice } from '../../src/modules/invoices/invoice-view';

function order(over: Partial<InvoiceOrderRow> = {}): InvoiceOrderRow {
  return {
    orderNumber: 'BMS-20260911-ABCD',
    status: 'PROCESSING',
    createdAt: new Date('2026-09-11T03:00:00.000Z'),
    deletedAt: null,
    subtotal: 100000,
    voucherCode: 'PROMO',
    voucherDiscountAmount: 15000,
    productDiscountAmount: 10000,
    shippingDiscountAmount: 5000,
    deliveryFee: 10000,
    paymentServiceFee: 0,
    totalPrice: 95000,
    paymentMethod: PaymentMethod.BANK_TRANSFER,
    shippingProvider: 'jne',
    shippingService: 'REG',
    shippingServiceName: 'JNE REG',
    trackingNumber: null,
    items: [
      { productName: 'Produk A', unitPrice: 50000, quantity: 2, spicyLevel: null, notes: null, toppings: [] },
    ],
    payment: { method: PaymentMethod.BANK_TRANSFER, status: 'PENDING', amount: 95123, uniqueCode: 123 },
    shipment: null,
    address: { recipientName: 'Budi', phone: '6281234567890', fullAddress: 'Jl. Test 1' },
    ...over,
  } as InvoiceOrderRow;
}

describe('Invoice discount breakdown (Phase 4D)', () => {
  it('maps product and shipping discount breakdown fields', () => {
    const inv = toCustomerInvoice(order());
    expect(inv.discount).toBe(15000);
    expect(inv.productDiscountAmount).toBe(10000);
    expect(inv.shippingDiscountAmount).toBe(5000);
    expect(inv.total).toBe(95000); // unchanged
  });

  it('maps zero breakdown for historical order with total discount only', () => {
    const inv = toCustomerInvoice(order({
      voucherDiscountAmount: 8000,
      productDiscountAmount: 0,
      shippingDiscountAmount: 0,
    } as Partial<InvoiceOrderRow>));
    expect(inv.discount).toBe(8000);
    expect(inv.productDiscountAmount).toBe(0);
    expect(inv.shippingDiscountAmount).toBe(0);
    expect(inv.total).toBe(95000); // total from row (unchanged by mapping)
  });

  it('maps zero discounts when no voucher', () => {
    const inv = toCustomerInvoice(order({
      voucherCode: null,
      voucherDiscountAmount: 0,
      productDiscountAmount: 0,
      shippingDiscountAmount: 0,
    } as Partial<InvoiceOrderRow>));
    expect(inv.discount).toBe(0);
    expect(inv.productDiscountAmount).toBe(0);
    expect(inv.shippingDiscountAmount).toBe(0);
  });

  it('INVOICE_ORDER_SELECT includes breakdown fields', () => {
    const select = JSON.stringify(INVOICE_ORDER_SELECT);
    expect(select).toContain('productDiscountAmount');
    expect(select).toContain('shippingDiscountAmount');
    expect(select).toContain('voucherDiscountAmount');
  });

  it('invoice view does not change total', () => {
    const inv = toCustomerInvoice(order({ totalPrice: 123456, voucherDiscountAmount: 5000, productDiscountAmount: 3000, shippingDiscountAmount: 2000 } as Partial<InvoiceOrderRow>));
    expect(inv.total).toBe(123456);
    expect(inv.discount).toBe(5000);
  });
});
