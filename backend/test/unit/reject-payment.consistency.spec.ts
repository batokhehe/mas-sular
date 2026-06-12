import { NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';

type FailOp = 'payment' | 'order' | 'outbox' | undefined;

const PAYMENT = { id: 'pay-1', orderId: 'order-1', deletedAt: null };
const UPDATED = { id: 'pay-1', orderId: 'order-1', status: 'FAILED' };

function buildTx(failOp: FailOp) {
  const tx = {
    payment: { update: jest.fn() },
    order: { update: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  tx.payment.update.mockImplementation(() =>
    failOp === 'payment' ? Promise.reject(new Error('payment update failed')) : Promise.resolve(UPDATED),
  );
  tx.order.update.mockImplementation(() =>
    failOp === 'order' ? Promise.reject(new Error('order update failed')) : Promise.resolve({ id: 'order-1' }),
  );
  tx.outboxEvent.create.mockImplementation(() =>
    failOp === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({}),
  );
  return tx;
}

function buildPrisma(tx: ReturnType<typeof buildTx>, payment: unknown = PAYMENT) {
  return {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
}

function build(failOp: FailOp = undefined, payment: unknown = PAYMENT) {
  const tx = buildTx(failOp);
  const prisma = buildPrisma(tx, payment);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any);
  return { service, prisma, tx };
}

describe('AdminService.rejectPayment atomicity', () => {
  it('commits payment.failed, order.cancelled and the outbox event in one transaction', async () => {
    const { service, prisma, tx } = build();

    const result = await service.rejectPayment('pay-1', { note: 'bad receipt' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { status: 'FAILED' } });
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: 'CANCELLED', events: { create: { status: 'CANCELLED', note: 'bad receipt' } } }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        aggregateType: 'payment',
        aggregateId: 'pay-1',
        eventName: 'payment.failed',
        eventVersion: 1,
        exchange: 'payments',
        routingKey: 'payment.failed',
        payload: { paymentId: 'pay-1', orderId: 'order-1' },
      }),
    });
    expect(result).toBe(UPDATED);
  });

  it('emits the outbox event as the LAST statement in the transaction', async () => {
    const { service, tx } = build();

    await service.rejectPayment('pay-1', {});

    const paymentOrder = tx.payment.update.mock.invocationCallOrder[0];
    const orderOrder = tx.order.update.mock.invocationCallOrder[0];
    const outboxOrder = tx.outboxEvent.create.mock.invocationCallOrder[0];
    expect(paymentOrder).toBeLessThan(orderOrder);
    expect(orderOrder).toBeLessThan(outboxOrder);
  });

  it('uses the default note when none is supplied', async () => {
    const { service, tx } = build();

    await service.rejectPayment('pay-1', {});

    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ events: { create: { status: 'CANCELLED', note: 'Payment rejected by admin' } } }),
      }),
    );
  });

  it('404s before opening a transaction when the payment is missing', async () => {
    const { service, prisma } = build(undefined, null);

    await expect(service.rejectPayment('pay-x', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s for a soft-deleted payment', async () => {
    const { service, prisma } = build(undefined, { ...PAYMENT, deletedAt: new Date() });

    await expect(service.rejectPayment('pay-1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rolls back (no event) when the order update fails', async () => {
    const { service, tx } = build('order');

    await expect(service.rejectPayment('pay-1', {})).rejects.toThrow('order update failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rejects when the outbox insert fails so the rejection is not half-applied', async () => {
    const { service, tx } = build('outbox');

    await expect(service.rejectPayment('pay-1', {})).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });
});
