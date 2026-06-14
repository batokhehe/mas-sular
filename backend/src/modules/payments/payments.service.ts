import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { UploadManualPaymentDto } from './application/dto/payment.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async uploadManualReceipt(paymentId: string, dto: UploadManualPaymentDto) {
    // The payment update and the payment.receipt_uploaded event must commit
    // atomically. No pre-read: a missing payment still surfaces P2025 from the
    // update (now inside the tx, so it rolls back). Outbox insert is last.
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'WAITING_VERIFICATION',
          manualReceiptUrl: dto.receiptUrl,
          manualBankName: dto.bankName,
          manualAccountName: dto.accountName,
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'payment',
          aggregateId: payment.id,
          eventName: 'payment.receipt_uploaded',
          eventVersion: 1,
          exchange: 'payments',
          routingKey: 'payment.receipt_uploaded',
          payload: { paymentId: payment.id, orderId: payment.orderId },
          metadata: { source: 'payments.uploadManualReceipt' },
          occurredAt: new Date(),
        },
      });
      return payment;
    }, { timeout: 10000 });
  }
}
