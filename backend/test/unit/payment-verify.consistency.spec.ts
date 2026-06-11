import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { AdminService } from '../../src/modules/admin/admin.service';

type FailOp = 'payment' | 'order' | 'audit' | 'outbox' | undefined;

const UPDATED_PAYMENT = {
  id: 'pay-1',
  orderId: 'order-1',
  amount: 50000,
  verifiedByUserId: 'admin-1',
  deletedAt: null,
};

function buildTx(failOp: FailOp) {
  const tx = {
    payment: { update: jest.fn() },
    order: { update: jest.fn() },
    auditLog: { create: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  tx.payment.update.mockImplementation(() =>
    failOp === 'payment' ? Promise.reject(new Error('payment update failed')) : Promise.resolve(UPDATED_PAYMENT),
  );
  tx.order.update.mockImplementation(() =>
    failOp === 'order' ? Promise.reject(new Error('order update failed')) : Promise.resolve({ id: 'order-1' }),
  );
  tx.auditLog.create.mockImplementation(() =>
    failOp === 'audit' ? Promise.reject(new Error('audit insert failed')) : Promise.resolve({ id: 'audit-1' }),
  );
  tx.outboxEvent.create.mockImplementation(() =>
    failOp === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({ id: 'evt-1' }),
  );
  return tx;
}

function buildPrisma(tx: ReturnType<typeof buildTx>, payment: unknown) {
  return {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    // Interactive transaction: invoke the callback with our tx mock.
    // If any inner op rejects, the whole promise rejects → real Prisma rolls back.
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
}

// Adapter so both verification paths run through the identical scenario matrix.
const PATHS = [
  {
    name: 'PaymentsService.verify',
    invoke: (prisma: unknown, eventBus: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new PaymentsService(prisma as any, eventBus as any);
      return svc.verify('pay-1', { adminUserId: 'admin-1' } as any);
    },
    expectedSource: 'payments.verify',
  },
  {
    name: 'AdminService.verifyPayment',
    invoke: (prisma: unknown, eventBus: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new AdminService(prisma as any, eventBus as any);
      return svc.verifyPayment('pay-1', 'admin-1', { note: 'looks good' } as any);
    },
    expectedSource: 'admin.verifyPayment',
  },
] as const;

describe.each(PATHS)('Payment verification atomicity — $name', (path) => {
  const eventBus = { publish: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('success path: all four writes happen in one transaction and no direct publish occurs', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT });

    const result = await path.invoke(prisma, eventBus);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.update).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(result).toBe(UPDATED_PAYMENT);

    // Legacy RabbitMQ publish is gone — delivery is now via the outbox.
    expect(eventBus.publish).not.toHaveBeenCalled();

    // Audit record: actorId NULL, admin captured in JSON payload.
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        action: 'payment.verified',
        entity: 'Payment',
        entityId: 'pay-1',
        after: expect.objectContaining({ verifiedByAdminId: 'admin-1', status: 'PAID' }),
      }),
    });

    // Enriched outbox event.
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'payment',
        aggregateId: 'pay-1',
        eventName: 'payment.paid',
        eventVersion: 1,
        exchange: 'payments',
        routingKey: 'payment.paid',
        payload: expect.objectContaining({
          paymentId: 'pay-1',
          orderId: 'order-1',
          amount: 50000,
          status: 'PAID',
          orderStatus: 'PROCESSING',
        }),
        metadata: expect.objectContaining({ source: path.expectedSource }),
      }),
    });
  });

  it('payment update failure: transaction rejects, no later writes, no publish', async () => {
    const tx = buildTx('payment');
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT });

    await expect(path.invoke(prisma, eventBus)).rejects.toThrow('payment update failed');
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('order update failure: transaction rejects, audit and outbox never written', async () => {
    const tx = buildTx('order');
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT });

    await expect(path.invoke(prisma, eventBus)).rejects.toThrow('order update failed');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('audit insert failure: transaction rejects, outbox never written', async () => {
    const tx = buildTx('audit');
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT });

    await expect(path.invoke(prisma, eventBus)).rejects.toThrow('audit insert failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('outbox insert failure: transaction rejects so PAID is never committed', async () => {
    const tx = buildTx('outbox');
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT });

    await expect(path.invoke(prisma, eventBus)).rejects.toThrow('outbox insert failed');
    // All four writes share one transaction; the rejection rolls back the PAID update.
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('unknown payment: 404 before any transaction is opened', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, null);

    await expect(path.invoke(prisma, eventBus)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
