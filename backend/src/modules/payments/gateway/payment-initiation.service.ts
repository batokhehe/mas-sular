import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { LogService } from '../../../infrastructure/logging/log.service';
import { PaymentChannelDescriptor } from './domain/payment-channel';
import { amountBreakdownOf, ChargeResult, ProviderStatus } from './domain/payment-provider.interface';
import { CheckoutGatewayPayload, buildGatewayPayloadFromLedger } from './domain/payment-instruction.builder';
import { PaymentGatewayPersistenceService } from './payment-gateway-persistence.service';
import { PaymentAttemptPricingService } from './payment-attempt-pricing.service';
import { PaymentChannelRegistry } from './payment-channel.registry';
import { PaymentProviderFactory } from './payment-provider.factory';
import { calculatePaymentServiceFee } from './domain/payment-service-fee';
import { feeSettingFor, loadPaymentServiceFeeConfig, PAYMENT_SERVICE_FEE_CONFIG, PaymentServiceFeeConfig } from './payment-service-fee.config';

/** Provider name assumed for rows created before gateways existed (Payment.provider is null). */
const DEFAULT_PROVIDER = 'manual';

const TERMINAL: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.REFUNDED];

/**
 * What `getInstructions` hands back. `gateway` keeps its exact previous meaning
 * and nullability; `status` and `expired` are ADDITIVE, so no existing consumer
 * of `{ gateway }` breaks.
 *
 * The storefront needs both extras: with the payability gates below, `gateway`
 * is null for a settled payment AND for a manual transfer AND for an expired
 * attempt, and those three must not render the same screen.
 */
export interface PaymentInstructionsResult {
  /** The payable attempt, or null when this payment can no longer be paid. */
  gateway: CheckoutGatewayPayload | null;
  /** Authoritative payment status. The storefront polls THIS, never the gateway. */
  status: PaymentStatus;
  /** The stored attempt exists but its provider-declared expiry has passed. */
  expired: boolean;
}

/**
 * The single seam between business code and payment providers.
 *
 * Phase 2 flow: validate payment → resolve channel → open a PENDING ledger row →
 * call the provider → persist the provider response → return the ChargeResult.
 *
 * It never changes a payment's STATUS: moving a payment to PAID/FAILED remains
 * the exclusive job of the existing CAS-guarded flows (admin verify/reject,
 * expiry worker, webhook applier). The one Payment/Order write it can cause is a
 * gateway attempt's payable amount + fee breakdown (PaymentAttemptPricingService,
 * PENDING payments only). A manual transfer writes only the ledger, as before.
 */
@Injectable()
export class PaymentInitiationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: PaymentChannelRegistry,
    private readonly providers: PaymentProviderFactory,
    private readonly ledger: PaymentGatewayPersistenceService,
    @Optional() private readonly logs?: LogService,
    // PAYMENT_SERVICE_FEE_ENABLED (who bears the fee). Optional for positional test
    // construction; absent -> read from the environment (default: merchant absorbs).
    @Optional() @Inject(PAYMENT_SERVICE_FEE_CONFIG) private readonly feeConfig?: PaymentServiceFeeConfig,
    // Opens gateway attempts with their fee. Optional for positional test construction.
    @Optional() private readonly pricing?: PaymentAttemptPricingService,
  ) {}

  /**
   * Open (or describe) the charge for an existing payment on the chosen channel.
   * Guards: payment exists, is not terminal, and the channel's business method
   * matches the method the order was placed with — a BANK_TRANSFER payment can
   * never be switched to a gateway channel behind the order's back.
   */
  async initiate(paymentId: string, channelCode: string): Promise<ChargeResult> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null },
      select: {
        id: true,
        orderId: true,
        method: true,
        status: true,
        amount: true,
        order: {
          select: {
            orderNumber: true,
            // Fee-exclusive base = totalPrice - paymentServiceFee (the invariant every
            // writer keeps): subtotal + shipping - discount, untouched by the fee.
            totalPrice: true,
            paymentServiceFee: true,
            user: { select: { name: true, email: true, phone: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (TERMINAL.includes(payment.status)) {
      throw new ConflictException(`Payment is already ${payment.status} and cannot be initiated`);
    }

    const { channel, provider } = this.channels.resolve(channelCode);
    this.assertMethodMatches(channel, payment.method);

    // The AUTHORITATIVE payment service fee, for the channel actually being
    // initiated — never the checkout-time preview, which may have been for another
    // channel. Gateway payments only; a manual transfer carries no gateway fee.
    const transactionBase = payment.order.totalPrice - payment.order.paymentServiceFee;
    if (payment.method === PaymentMethod.GATEWAY && !(Number.isInteger(transactionBase) && transactionBase > 0)) {
      // Never open (or charge) a gateway attempt for a zero/invalid amount.
      throw new ConflictException('Payment has no valid amount to charge');
    }
    // Pass-through follows the channel's own PAYMENT_FEE_<channel>_ENABLED, else the
    // global PAYMENT_SERVICE_FEE_ENABLED; the deciding variable goes into the snapshot.
    const feeSetting = feeSettingFor(this.feeConfig ?? loadPaymentServiceFeeConfig(), channel.code);
    const fee =
      payment.method === PaymentMethod.GATEWAY
        ? calculatePaymentServiceFee({
            paymentChannel: channel.code,
            transactionBase,
            feeEnabled: feeSetting.enabled,
            setting: feeSetting,
          })
        : null;

    // 3. Open the ledger row BEFORE calling the provider, so a charge that
    //    succeeds at the gateway but crashes on the way back is still traceable
    //    (the same "record the attempt first" rule the outbox and shipment
    //    booking claim already follow). Idempotent per payment+provider+channel.
    //    A new gateway attempt records its fee snapshot and moves the payable
    //    amount to it atomically; a replayed live attempt keeps its own snapshot.
    const attempt = {
      paymentId: payment.id,
      provider: provider.name,
      channelCode: channel.code,
      providerOrderId: payment.order.orderNumber,
      metadata: { method: payment.method, channel: channel.code },
    };
    const transaction = fee
      ? await (this.pricing ?? new PaymentAttemptPricingService(this.prisma)).openPricedAttempt({
          ...attempt,
          grossAmount: fee.customerTotal,
          serviceFee: {
            orderId: payment.orderId,
            baseAmount: fee.transactionBase,
            calculatedFee: fee.calculatedFee,
            customerFee: fee.customerFee,
            merchantAbsorbedFee: fee.merchantAbsorbedFee,
            feeEnabled: fee.feeEnabled,
            channel: channel.code,
            rule: fee.rule as unknown as Prisma.InputJsonValue | null,
          },
        })
      : await this.ledger.createPendingTransaction({ ...attempt, grossAmount: payment.amount });

    // 4. Call the provider (manual transfer performs no external I/O).
    let result: ChargeResult;
    try {
      result = await provider.createCharge({
        paymentId: payment.id,
        orderId: payment.orderId,
        orderNumber: payment.order.orderNumber,
        // Exactly the amount recorded on this attempt — the same figure webhook and
        // reconciliation amount checks validate against.
        amount: transaction.grossAmount,
        channel: channel.code,
        customer: {
          name: payment.order.user?.name ?? null,
          email: payment.order.user?.email ?? null,
          phone: payment.order.user?.phone ?? null,
        },
        // Lets a provider key its charge per ATTEMPT (Midtrans rejects a repeated
        // order_id), so a retry or channel switch can never collide.
        attemptId: transaction.id,
      });
    } catch (err) {
      // 5a. Record the failure on the attempt, then rethrow untouched so the
      //     caller's error contract is unchanged.
      const message = err instanceof Error ? err.message : String(err);
      await this.ledger.markFailed(transaction.id, message).catch(() => undefined);
      throw err;
    }

    // 5b. Persist what the provider returned.
    await this.ledger.updateGatewayResponse(transaction.id, {
      status: result.providerStatus ?? GatewayTransactionStatus.PENDING,
      // 5A: replace the placeholder written at step 3 with the id the provider
      // actually charged. Taken verbatim from the provider — never rebuilt here,
      // so GatewayTransaction.providerOrderId === the gateway's order_id exactly.
      ...(result.providerOrderId ? { providerOrderId: result.providerOrderId } : {}),
      providerReference: result.providerReference ?? null,
      providerTransactionId: result.providerTransactionId ?? null,
      redirectUrl: result.instructions.actionUrl ?? null,
      deeplinkUrl: result.instructions.kind === 'DEEPLINK' ? result.instructions.actionUrl ?? null : null,
      qrString: result.instructions.qrString ?? null,
      vaNumber: result.instructions.vaNumber ?? null,
      expiryAt: result.expiresAt,
      ...(result.metadata ? { metadata: result.metadata as Prisma.InputJsonValue } : {}),
      ...(result.raw !== undefined ? { rawResponse: result.raw as Prisma.InputJsonValue } : {}),
    });

    this.logs?.write({
      level: 'INFO',
      module: 'payments.gateway',
      action: 'payment.initiate',
      message: `charge described via ${provider.name}/${channel.code}`,
      paymentId: payment.id,
      orderId: payment.orderId,
      metadata: { provider: provider.name, channel: channel.code, status: result.status, gatewayTransactionId: transaction.id },
    });

    // Customer-facing amount breakdown of THIS attempt (never the merchant's absorbed
    // share). Absent for manual transfer and for attempts recorded before snapshots.
    const breakdown = amountBreakdownOf(transaction);
    return breakdown ? { ...result, amountBreakdown: breakdown } : result;
  }

  /**
   * Rebuild the payment instructions for an OPEN attempt from the ledger — used
   * by the payment-detail page on load/refresh AND by "Bayar Sekarang" on the
   * order list. Read-only: no provider call, so resuming can never open a second
   * charge. Ownership-scoped (generic 404).
   *
   * Payability is decided HERE, on the server. The countdown the customer sees is
   * presentation only and a tab can sit open indefinitely, so neither the expiry
   * nor the payment status may be trusted from the client.
   */
  async getInstructions(paymentId: string, userId: string): Promise<PaymentInstructionsResult> {
    const owned = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null, order: { userId } },
      select: { id: true, status: true },
    });
    // Generic 404 whether the payment is absent or owned by someone else — the
    // response must never reveal that another customer's payment exists.
    if (!owned) throw new NotFoundException('Payment not found');

    const notPayable = (expired: boolean): PaymentInstructionsResult => ({
      gateway: null,
      status: owned.status,
      expired,
    });

    // Gate 1 — only a PENDING payment is payable. A PAID payment must NEVER hand
    // back a scannable QR: the customer would pay a second time for an order that
    // is already settled, and nothing downstream would reconcile it.
    if (owned.status !== PaymentStatus.PENDING) return notPayable(false);

    const attempt = await this.ledger.findLatestByPayment(paymentId);
    if (!attempt) return notPayable(false); // manual transfer or never initiated

    // Gate 2 — the provider-declared deadline, compared against SERVER time. The
    // attempt is dead the moment it passes, whether or not the lifecycle worker
    // has flipped Payment.status yet. A null expiry means the channel has no
    // deadline, which is not the same as "expired".
    if (attempt.expiryAt && attempt.expiryAt.getTime() <= Date.now()) return notPayable(true);

    const descriptor = this.channels.find(attempt.channelCode);
    if (!descriptor) return notPayable(false);

    return {
      gateway: buildGatewayPayloadFromLedger(attempt, descriptor),
      status: owned.status,
      expired: false,
    };
  }

  /** Read the authoritative status from whichever provider owns this payment. */
  async refreshStatus(paymentId: string): Promise<ProviderStatus> {
    const { provider, ref } = await this.resolveOwner(paymentId);
    return provider.getStatus(ref);
  }

  /** Ask the owning provider to void an open charge. */
  async cancel(paymentId: string): Promise<ProviderStatus> {
    const { provider, ref } = await this.resolveOwner(paymentId);
    return provider.cancel(ref);
  }

  /** Payment.provider is null for every pre-gateway row → manual owns it. */
  private async resolveOwner(paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, deletedAt: null },
      select: { id: true, provider: true, providerReference: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    const name = payment.provider ?? DEFAULT_PROVIDER;
    const provider = this.providers.get(name);
    if (!provider) throw new NotFoundException(`Payment provider '${name}' is not registered`);

    return { provider, ref: { paymentId: payment.id, providerReference: payment.providerReference } };
  }

  private assertMethodMatches(channel: PaymentChannelDescriptor, method: PaymentMethod): void {
    if (channel.method !== method) {
      throw new ConflictException(
        `Channel '${channel.code}' cannot be used for a ${method} payment`,
      );
    }
  }
}
