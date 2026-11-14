import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { IncidentSeverity, PaymentGatewayTransaction, PaymentStatus } from '@prisma/client';
import { LogService } from '../../../infrastructure/logging/log.service';
import { IncidentCenterService, PaymentIncidentType } from '../../../infrastructure/logging/incident-center.service';
import { InventoryCoverageError } from '../../inventory/inventory-coverage.error';
import { PaymentSettlementService, SettlementActor } from '../settlement/payment-settlement.service';
import { StatusVerification } from './domain/midtrans-status-verification.util';

/**
 * THE convergence point (Phase 5E §5).
 *
 * The webhook and the reconciliation worker both arrive here with an already
 * VERIFIED provider status, and this is the only place that decides what it means
 * for the business. There is no webhook state machine and no reconciliation state
 * machine — both call `apply()`, which dispatches to the one shared transition in
 * PaymentSettlementService.
 *
 * The dispatch is driven entirely by the EXISTING mapper chain
 * (`mapMidtransStatus` → `mapGatewayStatusToPaymentStatus`), so no terminal-state
 * policy is invented here: `cancel` reaching FAILED, `capture`+challenge staying
 * PENDING and `expire` reaching EXPIRED are all decisions those mappers already own.
 */
export type ApplyOutcome =
  /** Payment moved to its new terminal state by this call. */
  | 'settled'
  | 'failed'
  | 'expired'
  /** Already in that state — idempotent replay, no side effects ran. */
  | 'already_terminal'
  /** Authoritative status does not warrant any transition (pending, refund, …). */
  | 'not_eligible'
  /** A legal-transition refusal: terminal payment or cancelled order. */
  | 'illegal_transition';

export interface ApplyRequest {
  transaction: PaymentGatewayTransaction;
  verified: Extract<StatusVerification, { ok: true }>;
  /** `payments.webhook.midtrans` or `payments.reconciliation.midtrans`. */
  source: string;
}

@Injectable()
export class GatewayStatusApplier {
  private readonly logger = new Logger('GatewayStatusApplier');

  constructor(
    private readonly settlement: PaymentSettlementService,
    @Optional() private readonly logs?: LogService,
    // C1-a: durable incidents for captured-but-unsettled payments. Optional so
    // positional construction in existing tests keeps working; IncidentCenterService
    // is provided by the @Global LoggingModule, so Nest always injects it.
    @Optional() private readonly incidents?: IncidentCenterService,
  ) {}

  async apply({ transaction, verified, source }: ApplyRequest): Promise<ApplyOutcome> {
    const actor: SettlementActor = {
      kind: 'GATEWAY',
      provider: transaction.provider,
      providerStatus: verified.facts.transactionStatus,
      providerTransactionId: verified.facts.transactionId,
      gatewayTransactionId: transaction.id,
      gatewayStatus: verified.gatewayStatus,
      source,
    };
    const reason = `Midtrans reported ${verified.facts.transactionStatus}`;

    try {
      switch (verified.paymentStatus) {
        // settlement, and capture with an acceptable fraud state.
        case PaymentStatus.PAID: {
          const out = await this.settlement.settle(transaction.paymentId, actor);
          return this.record(transaction, verified, source, out.result === 'SETTLED' ? 'settled' : 'already_terminal');
        }

        // deny, failure, cancel, capture+deny → the existing FAILED path, with its
        // restock and its `payment.failed` event.
        case PaymentStatus.FAILED: {
          const out = await this.settlement.fail(transaction.paymentId, actor, reason);
          return this.record(transaction, verified, source, out.result === 'APPLIED' ? 'failed' : 'already_terminal');
        }

        // expire → the existing expiry path, which releases reservations as EXPIRED
        // rather than as a plain cancellation.
        case PaymentStatus.EXPIRED: {
          const out = await this.settlement.expire(transaction.paymentId, actor, reason);
          return this.record(transaction, verified, source, out.result === 'APPLIED' ? 'expired' : 'already_terminal');
        }

        // pending / authorized (capture+challenge) — money has not moved and may
        // still. REFUNDED is deliberately inert: refunds are out of scope, and
        // guessing a reversal policy here would be worse than leaving it visible.
        default:
          return this.record(transaction, verified, source, 'not_eligible');
      }
    } catch (err) {
      if (err instanceof ConflictException) {
        // C1-a: when the provider says the money is captured but settlement was
        // refused, persist a durable incident BEFORE acknowledging. The settlement
        // transaction has already rolled back; the incident is its own transaction.
        // If that write fails the error propagates, so the notification stays
        // retryable instead of being acknowledged with nothing recorded.
        if (verified.paymentStatus === PaymentStatus.PAID) {
          await this.recordCapturedNotSettled(transaction, verified, source, err);
        }
        // Terminal payment or cancelled order: a conclusion, not a failure. Retrying
        // can never change it, so callers must not treat this as retryable.
        return this.record(transaction, verified, source, 'illegal_transition', err.message);
      }
      throw err; // rolled back → nothing partial → caller may retry
    }
  }

  /**
   * Captured-but-not-settled incident (C1-a). Dedup by (type, paymentId) lives in
   * IncidentCenterService.recordPaymentException, so webhook retries and
   * reconciliation passes bump one active incident instead of creating more.
   * Metadata holds correlators only — never a raw provider body or a credential.
   */
  private async recordCapturedNotSettled(
    transaction: PaymentGatewayTransaction,
    verified: Extract<StatusVerification, { ok: true }>,
    source: string,
    err: ConflictException,
  ): Promise<void> {
    if (!this.incidents) return;

    const coverage = err instanceof InventoryCoverageError ? err : null;
    const current = await this.settlement.currentState(transaction.paymentId);
    // Lost a race to a concurrent settle of the SAME payment (webhook vs
    // reconciliation): the payment IS paid and settled once. Nothing to record.
    if (!coverage && current?.status === PaymentStatus.PAID) return;

    const type: PaymentIncidentType = coverage ? 'payment.settlement_inventory_conflict' : 'payment.captured_not_settled';
    await this.incidents.recordPaymentException({
      type,
      paymentId: transaction.paymentId,
      orderId: coverage?.orderId ?? current?.orderId ?? null,
      severity: IncidentSeverity.HIGH,
      title: coverage
        ? 'Captured payment blocked: order stock no longer reserved'
        : 'Captured payment could not be settled',
      description: coverage
        ? `${transaction.provider} reported ${verified.facts.transactionStatus} but the order's reservations do not cover the ordered quantities; the payment was left unsettled. Manual review required (no automatic refund or re-reservation).`
        : `${transaction.provider} reported ${verified.facts.transactionStatus} but settlement was refused: ${err.message}. Manual review required (no automatic refund).`,
      source,
      module: 'payments.gateway',
      metadata: {
        provider: transaction.provider,
        providerOrderId: transaction.providerOrderId ?? null,
        providerTransactionId: verified.facts.transactionId ?? null,
        providerStatus: verified.facts.transactionStatus,
        gatewayTransactionId: transaction.id,
        paymentStatus: current?.status ?? null,
        reason: err.message,
        source,
        ...(coverage ? { shortfalls: coverage.shortfalls } : {}),
      },
    });
    this.logger.warn(`payment ${transaction.paymentId}: ${type} incident recorded`);
  }

  /** Safe observability. Correlators only — never a raw response or a credential. */
  private record(
    transaction: PaymentGatewayTransaction,
    verified: Extract<StatusVerification, { ok: true }>,
    source: string,
    result: ApplyOutcome,
    reason?: string,
  ): ApplyOutcome {
    this.logs?.write({
      level: result === 'illegal_transition' ? 'WARN' : 'INFO',
      module: 'payments.gateway',
      action: `gateway.apply.${result}`,
      message: `${verified.facts.transactionStatus} → ${result}`,
      paymentId: transaction.paymentId,
      metadata: {
        provider: transaction.provider,
        providerOrderId: transaction.providerOrderId,
        providerTransactionId: verified.facts.transactionId,
        providerStatus: verified.facts.transactionStatus,
        result,
        reason: reason ?? result,
        source,
      },
    });
    return result;
  }
}
