import { Injectable, NotFoundException } from '@nestjs/common';
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
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'PAID', verifiedByUserId: dto.adminUserId, verifiedAt: new Date() },
    });
    await this.prisma.order.update({ where: { id: payment.orderId }, data: { status: 'PROCESSING' } });
    await this.eventBus.publish('payments', 'payment.paid', {
      id: updated.id,
      name: 'payment.paid',
      occurredAt: new Date(),
      payload: { paymentId: updated.id, orderId: updated.orderId },
    });
    return updated;
  }
}
