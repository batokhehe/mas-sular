import { PaymentsService } from '../../src/modules/payments/payments.service';

type FailOp = 'payment' | 'outbox' | undefined;

const PAYMENT = { id: 'pay-1', orderId: 'order-1', status: 'WAITING_VERIFICATION' };
const DTO = { receiptUrl: 'https://cdn/receipt.png', bankName: 'BCA', accountName: 'Jane' };

function buildTx(failOp: FailOp) {
  const tx = {
    payment: { update: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  tx.payment.update.mockImplementation(() =>
    failOp === 'payment' ? Promise.reject(new Error('P2025: record not found')) : Promise.resolve(PAYMENT),
  );
  tx.outboxEvent.create.mockImplementation(() =>
    failOp === 'outbox' ? Promise.reject(new Error('outbox insert failed')) : Promise.resolve({}),
  );
  return tx;
}

function build(failOp: FailOp = undefined) {
  const tx = buildTx(failOp);
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new PaymentsService(prisma as any);
  return { service, prisma, tx };
}

describe('PaymentsService.uploadManualReceipt atomicity', () => {
  it('commits the payment update and the outbox event in one transaction', async () => {
    const { service, prisma, tx } = build();

    const result = await service.uploadManualReceipt('pay-1', DTO);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay-1' },
      data: {
        status: 'WAITING_VERIFICATION',
        manualReceiptUrl: DTO.receiptUrl,
        manualBankName: DTO.bankName,
        manualAccountName: DTO.accountName,
      },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        aggregateType: 'payment',
        aggregateId: 'pay-1',
        eventName: 'payment.receipt_uploaded',
        eventVersion: 1,
        exchange: 'payments',
        routingKey: 'payment.receipt_uploaded',
        payload: { paymentId: 'pay-1', orderId: 'order-1' },
      }),
    });
    expect(result).toBe(PAYMENT); // API contract / return value preserved
  });

  it('emits the outbox event AFTER the payment update', async () => {
    const { service, tx } = build();

    await service.uploadManualReceipt('pay-1', DTO);

    expect(tx.payment.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.outboxEvent.create.mock.invocationCallOrder[0],
    );
  });

  it('preserves P2025 behavior and writes no event when the payment is missing', async () => {
    const { service, tx } = build('payment');

    await expect(service.uploadManualReceipt('pay-x', DTO)).rejects.toThrow('P2025');
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('rolls back (rejects) when the outbox insert fails', async () => {
    const { service, tx } = build('outbox');

    await expect(service.uploadManualReceipt('pay-1', DTO)).rejects.toThrow('outbox insert failed');
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });
});
