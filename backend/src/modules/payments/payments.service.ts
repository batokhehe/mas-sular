import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EventBus } from '../../infrastructure/events/event-bus';
import { UploadManualPaymentDto, VerifyPaymentDto } from './application/dto/payment.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async uploadManualReceipt(paymentId: string, dto: UploadManualPaymentDto) {
    const payment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'WAITING_VERIFICATION',
        manualReceiptUrl: dto.receiptUrl,
        manualBankName: dto.bankName,
        manualAccountName: dto.accountName,
      },
    });
    await this.eventBus.publish('payments', 'payment.receipt_uploaded', {
      id: payment.id,
      name: 'payment.receipt_uploaded',
      occurredAt: new Date(),
      payload: { paymentId: payment.id, orderId: payment.orderId },
    });
    return payment;
  }

  async verify(paymentId: string, dto: VerifyPaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    const verifiedAt = new Date();
    // Payment must never become PAID unless the order update, audit record, and
    // outbox event all commit. All four writes run in one interactive transaction.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'PAID', verifiedByUserId: dto.adminUserId, verifiedAt },
      });
      await tx.order.update({ where: { id: payment.orderId }, data: { status: 'PROCESSING' } });
      // actorId is NULL: AuditLog.actorId FKs to User, but the verifier is an Admin.
      // The admin identity is recorded in the JSON payload instead.
      // NOTE (tech debt): verifiedByAdminId is taken from the request body on this path
      // (dto.adminUserId) rather than the authenticated principal — to be hardened later.
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payment.verified',
          entity: 'Payment',
          entityId: updated.id,
          after: { verifiedByAdminId: dto.adminUserId, status: 'PAID', orderStatus: 'PROCESSING' },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'payment',
          aggregateId: updated.id,
          eventName: 'payment.paid',
          eventVersion: 1,
          exchange: 'payments',
          routingKey: 'payment.paid',
          payload: {
            paymentId: updated.id,
            orderId: updated.orderId,
            amount: updated.amount,
            status: 'PAID',
            verifiedByUserId: updated.verifiedByUserId,
            verifiedAt: verifiedAt.toISOString(),
            orderStatus: 'PROCESSING',
          },
          metadata: { source: 'payments.verify' },
          occurredAt: verifiedAt,
        },
      });
      return updated;
    }, { timeout: 10000 });
  }
}
