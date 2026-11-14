import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { PaymentGatewayTransaction, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { LogService } from '../../../infrastructure/logging/log.service';
import { TERMINAL_GATEWAY_STATUSES } from './domain/gateway-status.mapper';
import { verifyMidtransStatusResponse } from './domain/midtrans-status-verification.util';
import { GatewayStatusApplier } from './gateway-status-applier.service';
import { MIDTRANS_CONFIG, MidtransConfig } from './midtrans.config';
import { IncidentCenterService } from '../../../infrastructure/logging/incident-center.service';
import {
  DEFAULT_BLOCKED_RETRY_BASE_MS,
  DEFAULT_BLOCKED_RETRY_MAX_MS,
  MIDTRANS_RECONCILIATION_CONFIG,
  MidtransReconciliationConfig,
} from './midtrans-reconciliation.config';
import { PaymentProviderFactory } from './payment-provider.factory';
import { MIDTRANS_PROVIDER } from './payment-webhook.service';

export interface ReconciliationTick {
  scanned: number;
  transitioned: number;
  unchanged: number;
  failed: number;
  /** C1-a.1: blocked payments held back this tick because their retry backoff has not elapsed. */
  deferred: number;
}

/** C1-a.1: the only incident type that defers reconciliation. */
const BLOCKED_INCIDENT_TYPE = 'payment.settlement_inventory_conflict' as const;

/**
 * C1-a.1: retry delay after the `count`-th recorded occurrence of a blocked
 * payment: base, 2·base, 4·base, … capped at max. Pure, for the tests.
 */
/** A short driver error code (e.g. Prisma `P1001`) when present; never the message. */
function deferralErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length <= 32 ? code : null;
}

export function blockedRetryDelayMs(count: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(count, 1) - 1, 30); // 2^30 already exceeds any sane cap
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Recovers gateway charges whose outcome we never learned — the webhook was never
 * delivered, or it arrived while the Status API was unreachable and was recorded
 * VERIFICATION_FAILED.
 *
 * It owns NO business logic. Each candidate goes through the same three existing
 * pieces the webhook uses — the Midtrans Status API via the existing provider, the
 * existing response validator, and `GatewayStatusApplier` — so reconciliation and
 * the webhook cannot drift apart. Concurrency is left entirely to the database:
 * the payment CAS decides the winner, so no claim, lock or mutex exists here.
 *
 * Follows the existing worker pattern (self-scheduled, bounded batch, retry-next-
 * tick, structured logging). Disabled by default.
 */
@Injectable()
export class MidtransReconciliationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('MidtransReconciliationWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private lastHealthLogAt = 0;

  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderFactory,
    private readonly applier: GatewayStatusApplier,
    @Inject(MIDTRANS_RECONCILIATION_CONFIG) private readonly config: MidtransReconciliationConfig,
    @Inject(MIDTRANS_CONFIG) private readonly gateway: MidtransConfig,
    @Optional() private readonly logs?: LogService,
    // C1-a.1: source of the durable retry state for blocked payments. Optional so
    // positional construction keeps working; absent → no deferral (old behaviour).
    @Optional() private readonly incidents?: IncidentCenterService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Midtrans reconciliation disabled (MIDTRANS_RECONCILIATION_ENABLED=false)');
      return;
    }
    // With the gateway off, the Midtrans provider is never registered, so every
    // sweep would fail on every candidate. Stay down rather than log an error a
    // minute — reconciliation is meaningless without the provider it reconciles.
    if (!this.gateway.enabled) {
      this.logger.warn('Midtrans reconciliation not started: MIDTRANS_ENABLED=false');
      return;
    }
    this.logger.log(
      `Midtrans reconciliation starting (interval=${this.config.pollIntervalMs}ms, batch=${this.config.batchSize}, minAge=${this.config.minAgeMs}ms)`,
    );
    this.scheduleNext(this.config.initialDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already logged
      }
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runTick(), delayMs);
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        const tick = await this.reconcile();
        this.maybeHealthLog(tick);
        if (tick.transitioned > 0 || tick.failed > 0) {
          this.logs?.write({
            level: tick.failed > 0 ? 'WARN' : 'INFO',
            module: 'worker.midtrans-reconciliation',
            action: 'tick',
            message: `midtrans reconciliation: transitioned=${tick.transitioned} unchanged=${tick.unchanged} failed=${tick.failed} deferred=${tick.deferred}`,
            metadata: { ...tick },
          });
        }
      } catch (err) {
        // Transient failure (e.g. the candidate query) → retried on the next tick.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`midtrans reconciliation tick failed: ${message}`);
        this.logs?.write({
          level: 'ERROR', module: 'worker.midtrans-reconciliation', action: 'tick.failed', message,
          metadata: { stack: err instanceof Error ? err.stack : undefined },
        });
      }
    })();
    await this.inFlight;
    this.inFlight = null;
    this.running = false;
    this.scheduleNext(this.config.pollIntervalMs);
  }

  /**
   * Candidates: Midtrans charges still open on BOTH sides — the ledger row is
   * non-terminal AND the payment is still awaiting money — that are old enough not
   * to be racing their own charge request.
   *
   * The payment-status filter is the ONLY eligibility rule, deliberately. An earlier
   * version also skipped charges whose recorded notifications had all concluded;
   * that silently defeated the worker's whole purpose, because a notification that
   * concluded NOT_ELIGIBLE only means "not paid YET" — if the later settlement
   * webhook was then lost, the charge could never be recovered (Phase 5F defect).
   * A concluded-as-SETTLED charge needs no such rule: its payment is PAID, so the
   * filter below already excludes it.
   *
   * Manual BANK_TRANSFER is excluded structurally by `provider = midtrans`.
   */
  private findCandidates(cutoff: Date, deferredPaymentIds: string[] = []): Promise<PaymentGatewayTransaction[]> {
    return this.prisma.paymentGatewayTransaction.findMany({
      where: {
        provider: MIDTRANS_PROVIDER,
        providerOrderId: { not: null },
        status: { notIn: [...TERMINAL_GATEWAY_STATUSES] },
        createdAt: { lte: cutoff },
        // The money side must still be open. This is what makes an already PAID /
        // FAILED / EXPIRED payment a non-candidate rather than a no-op.
        payment: {
          deletedAt: null,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION] },
        },
        // C1-a.1: blocked payments still inside their backoff window are left out
        // BEFORE `take`, so they can never occupy the batch ahead of newer charges.
        ...(deferredPaymentIds.length > 0 ? { paymentId: { notIn: deferredPaymentIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: this.config.batchSize,
    });
  }

  /**
   * C1-a.1: payments to hold back this tick. A gateway payment blocked by an
   * inventory coverage conflict stays PENDING (settlement is refused, nothing is
   * settled, refunded or re-reserved) and would otherwise be retried every tick,
   * oldest first, crowding newer charges out of the batch. Its ACTIVE
   * `payment.settlement_inventory_conflict` incident already records how often
   * (`count`) and when last (`lastSeen`) it failed, so that is the backoff state:
   * no schema change. Each retry that fails again bumps the incident, which pushes
   * the next retry further out (base, 2·base, … up to max).
   *
   * Only this incident type defers; every other failure (Status API errors,
   * verification failures, rolled-back transactions) is retried next tick as
   * before. Resolving the incident clears the deferral immediately. If the lookup
   * itself fails, nothing is deferred (fail open = the previous behaviour).
   */
  private async deferredPaymentIds(): Promise<string[]> {
    if (!this.incidents) return [];
    const base = this.config.blockedRetryBaseMs ?? DEFAULT_BLOCKED_RETRY_BASE_MS;
    const max = this.config.blockedRetryMaxMs ?? DEFAULT_BLOCKED_RETRY_MAX_MS;
    const now = this.nowMs();
    try {
      const blocked = await this.incidents.listActivePaymentExceptions(BLOCKED_INCIDENT_TYPE);
      return blocked
        .filter((b) => now - b.lastSeen.getTime() < blockedRetryDelayMs(b.count, base, max))
        .map((b) => b.paymentId);
    } catch (err) {
      // Fail OPEN: no deferral this tick, i.e. the pre-C1-a.1 query. Logged once
      // per tick (this lookup runs once per sweep), never per candidate. Error
      // CLASS and driver code only — never the message, consistent with the rest
      // of this worker; no payment, provider or credential data is involved here.
      const context = {
        incidentType: BLOCKED_INCIDENT_TYPE,
        errorClass: err instanceof Error ? err.name : 'unknown',
        errorCode: deferralErrorCode(err),
        fallback: 'no_deferral',
      };
      this.logger.warn({ event: 'reconciliation.deferral_lookup_failed', ...context });
      this.logs?.write({
        level: 'WARN',
        module: 'worker.midtrans-reconciliation',
        action: 'deferral.lookup_failed',
        message: 'blocked-payment backoff lookup failed; reconciling without deferral this tick',
        metadata: context,
      });
      return [];
    }
  }

  /** One sweep. A failing candidate never aborts the batch. */
  async reconcile(): Promise<ReconciliationTick> {
    const cutoff = new Date(this.nowMs() - this.config.minAgeMs);
    const deferred = await this.deferredPaymentIds();
    const candidates = await this.findCandidates(cutoff, deferred);

    const tick: ReconciliationTick = { scanned: candidates.length, transitioned: 0, unchanged: 0, failed: 0, deferred: deferred.length };

    for (const transaction of candidates) {
      if (this.stopped) break;
      try {
        const outcome = await this.reconcileOne(transaction);
        if (outcome === 'transitioned') tick.transitioned += 1;
        else tick.unchanged += 1;
      } catch (err) {
        // One gateway error, one malformed body, one rolled-back transaction — none
        // of it stops the sweep. The row stays a candidate for the next tick.
        tick.failed += 1;
        this.logger.warn({
          event: 'reconciliation.failed',
          providerOrderId: transaction.providerOrderId,
          reason: err instanceof Error ? err.name : 'unknown',
        });
        this.logs?.write({
          level: 'WARN',
          module: 'worker.midtrans-reconciliation',
          action: 'candidate.failed',
          message: 'candidate could not be reconciled',
          paymentId: transaction.paymentId,
          metadata: {
            provider: transaction.provider,
            providerOrderId: transaction.providerOrderId,
            // Error CLASS only — never the message, which can echo a request header.
            reason: err instanceof Error ? err.name : 'unknown',
          },
        });
      }
    }
    return tick;
  }

  /**
   * Read the authoritative status and route it through the shared applier.
   * Throws on anything that leaves the truth unknown, so the caller counts it as a
   * failure and the row is retried later — never mutated on a guess.
   */
  async reconcileOne(transaction: PaymentGatewayTransaction): Promise<'transitioned' | 'unchanged'> {
    const provider = this.providers.get(transaction.provider);
    if (!provider) throw new Error(`provider ${transaction.provider} is not registered`);

    // The EXACT id from Phase 5A. Never rebuilt from orderNumber + attemptId, and
    // never Order.orderNumber.
    const providerOrderId = transaction.providerOrderId;
    if (!providerOrderId) return 'unchanged'; // defensive; the query already excludes these

    // Existing client, existing retry classification. A timeout/429/5xx surfaces
    // here and is caught by the caller — no mutation on the way out.
    const status = await provider.getStatus({
      paymentId: transaction.paymentId,
      providerReference: providerOrderId,
    });

    const verified = verifyMidtransStatusResponse(status.raw, providerOrderId, transaction.grossAmount);
    if (!verified.ok) {
      // Unknown at Midtrans, wrong order, wrong amount, or unparseable: log the
      // classification and change nothing. Never create an Order/Payment/ledger row.
      this.logs?.write({
        level: 'WARN',
        module: 'worker.midtrans-reconciliation',
        action: 'candidate.not_verified',
        message: 'authoritative status failed verification',
        paymentId: transaction.paymentId,
        metadata: { provider: transaction.provider, providerOrderId, reason: verified.reason },
      });
      return 'unchanged';
    }

    const outcome = await this.applier.apply({
      transaction,
      verified,
      source: `payments.reconciliation.${MIDTRANS_PROVIDER}`,
    });

    return outcome === 'settled' || outcome === 'failed' || outcome === 'expired' ? 'transitioned' : 'unchanged';
  }

  private maybeHealthLog(tick: ReconciliationTick): void {
    const now = this.nowMs();
    if (now - this.lastHealthLogAt >= this.config.healthLogIntervalMs) {
      this.lastHealthLogAt = now;
      this.logger.log({ health: 'midtrans-reconciliation-worker', ...tick });
    }
  }
}
