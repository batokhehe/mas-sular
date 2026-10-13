import { ConflictException, Injectable } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentGatewayTransaction, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CreatePendingTransactionInput } from './payment-gateway-persistence.service';

/** Gateway states that mean "this attempt is still live" — at most one per payment. */
const ACTIVE: GatewayTransactionStatus[] = [GatewayTransactionStatus.PENDING, GatewayTransactionStatus.AUTHORIZED];

/** The authoritative payment service fee of ONE gateway attempt. */
export interface AttemptServiceFeeInput {
  orderId: string;
  /** Fee-exclusive amount: subtotal + shipping - discount. */
  baseAmount: number;
  /** Applicable Midtrans fee, recorded in both PAYMENT_SERVICE_FEE_ENABLED modes. */
  calculatedFee: number;
  /** Part charged to the customer ("Biaya Layanan"). */
  customerFee: number;
  /** Part the merchant bears. calculatedFee = customerFee + merchantAbsorbedFee. */
  merchantAbsorbedFee: number;
  feeEnabled: boolean;
  channel: string;
  rule: Prisma.InputJsonValue | null;
}

/** grossAmount must equal serviceFee.baseAmount + serviceFee.customerFee. */
export type PricedAttemptInput = CreatePendingTransactionInput & { serviceFee: AttemptServiceFeeInput };

/**
 * Opens a gateway attempt together with its authoritative payment service fee.
 *
 * Kept apart from PaymentGatewayPersistenceService on purpose: that ledger is
 * reachable from the webhook path and never writes Payment/Order rows. Pricing an
 * attempt must move the payable amount, so it lives here, where only payment
 * initiation can reach it.
 */
@Injectable()
export class PaymentAttemptPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Same-channel replay of the live attempt returns it unchanged, WITH its own fee
   * snapshot and amount: a live charge's amount is fixed at the gateway, so it is
   * never recalculated, even if the fee configuration changed in between.
   *
   * Otherwise, atomically:
   *   1. every live attempt of the payment is superseded;
   *   2. Payment.amount moves to grossAmount — only while the payment is still
   *      PENDING (CAS), so a settled payment's amount can never be rewritten;
   *   3. the order's current fee breakdown and payable total follow;
   *   4. the attempt is written with grossAmount and the full fee snapshot.
   * The gateway is then charged exactly this row's grossAmount, and webhook /
   * reconciliation amount checks validate against the same column.
   */
  async openPricedAttempt(input: PricedAttemptInput): Promise<PaymentGatewayTransaction> {
    const fee = input.serviceFee;
    if (input.grossAmount !== fee.baseAmount + fee.customerFee) {
      throw new Error('payment attempt grossAmount must equal baseAmount + customer service fee');
    }

    const existing = await this.prisma.paymentGatewayTransaction.findFirst({
      where: { paymentId: input.paymentId, status: { in: ACTIVE } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing && existing.provider === input.provider && existing.channelCode === input.channelCode) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialise concurrent attempts on this payment, then supersede EVERY live
      // attempt so exactly one attempt — this one — carries the payable amount.
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
      await tx.paymentGatewayTransaction.updateMany({
        where: { paymentId: input.paymentId, status: { in: ACTIVE } },
        data: { status: GatewayTransactionStatus.CANCELLED, failureReason: 'Superseded by a new channel selection' },
      });

      const moved = await tx.payment.updateMany({
        where: { id: input.paymentId, status: PaymentStatus.PENDING, deletedAt: null },
        data: { amount: input.grossAmount },
      });
      if (moved.count !== 1) {
        throw new ConflictException('Payment is no longer pending; its amount cannot change');
      }

      await tx.order.update({
        where: { id: fee.orderId },
        data: {
          totalPrice: input.grossAmount,
          paymentServiceFee: fee.customerFee,
          paymentServiceFeeCalculated: fee.calculatedFee,
          paymentServiceFeeAbsorbed: fee.merchantAbsorbedFee,
          paymentServiceFeeEnabled: fee.feeEnabled,
          paymentServiceFeeChannel: fee.channel,
          paymentServiceFeeRule: fee.rule ?? Prisma.DbNull,
        },
      });

      return tx.paymentGatewayTransaction.create({
        data: {
          paymentId: input.paymentId,
          provider: input.provider,
          channelCode: input.channelCode,
          grossAmount: input.grossAmount,
          baseAmount: fee.baseAmount,
          serviceFeeCalculated: fee.calculatedFee,
          serviceFeeCustomer: fee.customerFee,
          serviceFeeAbsorbed: fee.merchantAbsorbedFee,
          serviceFeeEnabled: fee.feeEnabled,
          serviceFeeRule: fee.rule ?? Prisma.DbNull,
          currency: input.currency ?? 'IDR',
          providerOrderId: input.providerOrderId ?? null,
          status: GatewayTransactionStatus.PENDING,
          rawRequest: input.rawRequest,
          metadata: input.metadata,
        },
      });
    });
  }
}
