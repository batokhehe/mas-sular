import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { buildAdminNotification } from '../../src/infrastructure/admin-notifications/admin-notification.builder';

/**
 * P1 #15 — after an AUTOMATIC courier booking succeeds, the admin is notified with
 * the OFFICIAL AWB the courier returned.
 *
 * Before: the automatic path flipped the order to SHIPPED and queued the customer's
 * WhatsApp (with the AWB), but emitted no domain event, so the admin "Order
 * Shipped" notification — built only from `order.status_updated` — never fired.
 *
 * The AWB here is whatever the PROVIDER returned as `trackingNumber` (JNE cnote_no,
 * Paxel airwaybill_code — provenance is pinned in runtime-booking-verification).
 * Nothing in this path may derive, substitute or invent one.
 */

const AWB = { jne: 'JNE0099887766', paxel: 'PXL0099887766' } as const;

function order(provider: 'jne' | 'paxel') {
  return {
    id: 'o1',
    orderNumber: 'BMS-15',
    totalPrice: 150000,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: provider,
    shippingService: provider === 'jne' ? 'REG' : 'PAXEL_NEXTDAY',
    shippingServiceName: provider === 'jne' ? 'JNE Reguler' : 'Paxel Next Day',
    payment: { verifiedAt: new Date('2026-09-05T07:00:00.000Z') },
    shipment: {
      id: 'sh-15',
      provider,
      service: provider === 'jne' ? 'REG' : 'PAXEL_NEXTDAY',
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      // Paxel needs a slot; give it an explicit one so this spec is about AWB only.
      metadata: provider === 'paxel' ? { paxel: { pickupDatetime: '2026-09-05T10:00:00.000Z' } } : null,
    },
    address: {
      recipientName: 'Budi', phone: '628123', addressDetail: 'Jl. Test 1', fullAddress: 'Jl. Test 1',
      postalCode: '40131', notes: null, latitude: -6.8, longitude: 107.5,
      province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' },
      district: { name: 'Sukajadi' }, village: { name: 'Pasteur' },
    },
    user: { name: 'Budi', email: 'budi@test.com', phone: null },
    items: [{
      quantity: 1, productName: 'Bakso', unitPrice: 45000, weightGram: 450, lengthCm: 20, widthCm: 15,
      heightCm: 10, isFragile: false, product: { sku: 'SKU-1', name: 'Bakso', category: { name: 'Makanan' } },
    }],
  };
}

const OUTLET = {
  id: 'out1', name: 'Pusat', postalCode: '40286', addressDetail: 'Jl. Outlet', latitude: -6.9, longitude: 107.6,
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Buahbatu' }, village: { name: 'Margasari' },
};

function build(provider: 'jne' | 'paxel', over: { orderFlipCount?: number; courierFails?: boolean; existingAwb?: string } = {}) {
  const theOrder = order(provider);
  if (over.existingAwb) Object.assign(theOrder.shipment, { trackingNumber: over.existingAwb, status: ShipmentStatus.CREATED });
  const tx = {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: over.orderFlipCount ?? 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(theOrder) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET), findUnique: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ metadata: theOrder.shipment.metadata }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const courier = {
    name: provider,
    requiresPickupSchedule: provider === 'paxel',
    supportsAutomaticBooking: true,
    createShipment: over.courierFails
      ? jest.fn().mockRejectedValue(new Error('provider 500: courier down'))
      : jest.fn().mockResolvedValue({
          trackingNumber: AWB[provider],
          providerShipmentId: AWB[provider],
          status: ShipmentStatus.CREATED,
          rawPayload: provider === 'jne' ? { detail: [{ cnote_no: AWB.jne }] } : { data: { airwaybill_code: AWB.paxel } },
        }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, { get: jest.fn().mockReturnValue(courier) } as any);
  return { service, tx, prisma, courier };
}

/** The order.status_updated rows the success transaction wrote. */
type OutboxRow = Record<string, unknown> & { payload: Record<string, unknown> };
const shippedEvents = (tx: ReturnType<typeof build>['tx']): OutboxRow[] =>
  tx.outboxEvent.create.mock.calls
    .map(([arg]: [{ data: OutboxRow }]) => arg.data)
    .filter((d: OutboxRow) => d.eventName === 'order.status_updated');

describe.each(['jne', 'paxel'] as const)('automatic %s booking -> admin notification carries the official AWB', (provider) => {
  it('emits exactly ONE order.status_updated SHIPPED event with the AWB the courier returned', async () => {
    const { service, tx } = build(provider);

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: AWB[provider] });
    const events = shippedEvents(tx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'order',
      aggregateId: 'o1',
      exchange: 'orders',
      routingKey: 'order.status_updated',
      metadata: { source: 'shipment.auto_booking' },
    });
    expect(events[0].payload).toEqual({
      orderId: 'o1',
      orderNumber: 'BMS-15',
      status: OrderStatus.SHIPPED,
      shipmentId: 'sh-15',
      trackingNumber: AWB[provider],
      shippingProvider: provider,
    });
  });

  it('commits the event in the SAME transaction as the SHIPPED flip, the AWB write and the customer WhatsApp', async () => {
    const { service, tx, prisma } = build(provider);

    await service.createForOrder('o1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.shipment.update.mock.calls[0][0].data.trackingNumber).toBe(AWB[provider]);
    expect(tx.order.updateMany.mock.calls[0][0].data).toEqual({ status: OrderStatus.SHIPPED, trackingNumber: AWB[provider] });
    expect(tx.notificationOutbox.create.mock.calls[0][0].data.payload.trackingNumber).toBe(AWB[provider]);
    expect(shippedEvents(tx)[0].payload.trackingNumber).toBe(AWB[provider]);
  });

  it('the admin "Order Shipped" notification built from that event shows the courier and AWB', async () => {
    const { service, tx } = build(provider);
    await service.createForOrder('o1');

    const bell = buildAdminNotification('order.status_updated', shippedEvents(tx)[0].payload);

    expect(bell).toMatchObject({ eventType: 'order.shipped', title: 'Order Shipped', url: '/orders/o1' });
    expect(bell!.message).toBe(`Order BMS-15 handed to ${provider.toUpperCase()} · AWB ${AWB[provider]}`);
    expect(bell!.metadata).toEqual({
      orderId: 'o1',
      orderNumber: 'BMS-15',
      shipmentId: 'sh-15',
      trackingNumber: AWB[provider],
      shippingProvider: provider,
    });
  });

  it('provider failure: no AWB, no SHIPPED event, no shipped notification of any kind', async () => {
    const { service, tx, prisma } = build(provider, { courierFails: true });

    const outcome = await service.createForOrderSafe('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.notificationOutbox.create).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    // Marked FAILED only where no AWB exists — never a fake one.
    expect(prisma.shipment.updateMany.mock.calls.at(-1)[0]).toMatchObject({
      where: { orderId: 'o1', trackingNumber: null },
      data: { status: ShipmentStatus.FAILED },
    });
  });

  it('order cancelled while the courier call was in flight: AWB kept for ops, nobody told it shipped', async () => {
    const { service, tx } = build(provider, { orderFlipCount: 0 });

    await service.createForOrder('o1');

    expect(tx.shipment.update.mock.calls[0][0].data.trackingNumber).toBe(AWB[provider]);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.notificationOutbox.create).not.toHaveBeenCalled();
  });

  it('replay after a successful booking: no second courier call and no second event', async () => {
    const { service, tx, courier } = build(provider, { existingAwb: AWB[provider] });

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: AWB[provider] });
    expect(courier.createShipment).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

describe('admin notification contract is otherwise unchanged', () => {
  it('a MANUAL admin SHIPPED transition (no AWB in its payload) keeps its exact message and metadata', () => {
    expect(buildAdminNotification('order.status_updated', { orderId: 'o1', orderNumber: 'BMS-15', status: 'SHIPPED' })).toEqual({
      eventType: 'order.shipped',
      category: 'ORDER',
      priority: 'MEDIUM',
      title: 'Order Shipped',
      message: 'Order BMS-15 handed to the courier.',
      url: '/orders/o1',
      icon: 'truck',
      metadata: { orderId: 'o1' },
    });
  });

  it('never invents an AWB: a blank or missing trackingNumber falls back to the manual wording', () => {
    for (const trackingNumber of [undefined, null, '']) {
      const bell = buildAdminNotification('order.status_updated', { orderId: 'o1', status: 'SHIPPED', trackingNumber });
      expect(bell!.message).not.toMatch(/AWB/);
      expect(bell!.metadata).toEqual({ orderId: 'o1' });
    }
  });

  it('checkout "New Order Received" stays independent of any AWB (it precedes payment and booking)', () => {
    const bell = buildAdminNotification('order.created', { orderId: 'o1', orderNumber: 'BMS-15', totalPrice: 150000 });
    expect(bell).toMatchObject({ eventType: 'order.created', title: 'New Order Received', metadata: { orderId: 'o1', orderNumber: 'BMS-15' } });
    expect(JSON.stringify(bell)).not.toMatch(/tracking|AWB/i);
  });

  it('payment.paid ("Payment Verified") is unchanged and carries no AWB — booking has not happened yet', () => {
    const bell = buildAdminNotification('payment.paid', { paymentId: 'p1', orderId: 'o1', amount: 150000 });
    expect(bell).toMatchObject({ eventType: 'payment.verified', title: 'Payment Verified', metadata: { paymentId: 'p1', orderId: 'o1' } });
    expect(JSON.stringify(bell)).not.toMatch(/tracking|AWB/i);
  });
});
