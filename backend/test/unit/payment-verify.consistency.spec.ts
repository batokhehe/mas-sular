import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';

type FailOp = 'payment' | 'order' | 'audit' | 'outbox' | undefined;

const UPDATED_PAYMENT = {
  id: 'pay-1',
  orderId: 'order-1',
  amount: 50000,
  status: 'PAID',
  verifiedByUserId: 'admin-1',
  deletedAt: null,
};

// Pre-read row (still verifiable): non-terminal status.
const PENDING_PAYMENT = { ...UPDATED_PAYMENT, status: 'WAITING_VERIFICATION' };

function buildTx(failOp: FailOp, casCount = 1) {
  const tx = {
    payment: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    order: { update: jest.fn() },
    auditLog: { create: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  tx.payment.updateMany.mockImplementation(() =>
    failOp === 'payment' ? Promise.reject(new Error('payment update failed')) : Promise.resolve({ count: casCount }),
  );
  tx.payment.findUniqueOrThrow.mockResolvedValue(UPDATED_PAYMENT);
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
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
}

function invoke(prisma: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new AdminService(prisma as any);
  return svc.verifyPayment('pay-1', 'admin-1', { note: 'looks good' } as any);
}

describe('AdminService.verifyPayment — hardened verification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('success: CAS flip + four writes in one transaction, emits payment.paid', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    const result = await invoke(prisma);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
    // CAS guard targets only the non-terminal states.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: { notIn: ['PAID', 'FAILED'] } },
      data: expect.objectContaining({ status: 'PAID', verifiedByUserId: 'admin-1' }),
    });
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(result).toBe(UPDATED_PAYMENT);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        action: 'payment.verified',
        entity: 'Payment',
        entityId: 'pay-1',
        after: expect.objectContaining({ verifiedByAdminId: 'admin-1', status: 'PAID' }),
      }),
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'payment',
        aggregateId: 'pay-1',
        eventName: 'payment.paid',
        routingKey: 'payment.paid',
        payload: expect.objectContaining({ paymentId: 'pay-1', orderId: 'order-1', amount: 50000, status: 'PAID' }),
        metadata: expect.objectContaining({ source: 'admin.verifyPayment' }),
      }),
    });
  });

  it('idempotency: already-PAID is rejected before any transaction opens', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT, status: 'PAID' });

    await expect(invoke(prisma)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('idempotency: already-FAILED is rejected before any transaction opens', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, { ...UPDATED_PAYMENT, status: 'FAILED' });

    await expect(invoke(prisma)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('duplicate-event prevention: a concurrent verify that loses the CAS (count 0) emits no payment.paid', async () => {
    const tx = buildTx(undefined, 0); // CAS matched nothing → another verifier already flipped it
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    await expect(invoke(prisma)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.payment.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('payment CAS failure: transaction rejects, no later writes, no publish', async () => {
    const tx = buildTx('payment');
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    await expect(invoke(prisma)).rejects.toThrow('payment update failed');
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('order update failure: transaction rejects, audit and outbox never written', async () => {
    const tx = buildTx('order');
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    await expect(invoke(prisma)).rejects.toThrow('order update failed');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('audit insert failure: transaction rejects, outbox never written', async () => {
    const tx = buildTx('audit');
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    await expect(invoke(prisma)).rejects.toThrow('audit insert failed');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('outbox insert failure: transaction rejects so PAID is never committed', async () => {
    const tx = buildTx('outbox');
    const prisma = buildPrisma(tx, { ...PENDING_PAYMENT });

    await expect(invoke(prisma)).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('unknown payment: 404 before any transaction is opened', async () => {
    const tx = buildTx(undefined);
    const prisma = buildPrisma(tx, null);

    await expect(invoke(prisma)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
