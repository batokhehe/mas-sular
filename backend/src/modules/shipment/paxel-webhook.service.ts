import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../../infrastructure/logging/log.service';
import { extractPaxelSignedFields, mergePaxelWebhook, PaxelWebhookPayload, parsePaxelWebhook } from './domain/paxel-webhook';
import { decideShipmentTransition, ShipmentTransitionDecision } from './domain/shipment-transition';
import { verifyPaxelWebhookSignature } from './infrastructure/providers/paxel-signature';
import { loadPaxelWebhookConfig, PAXEL_WEBHOOK_CONFIG, PaxelWebhookConfig } from './paxel-webhook.config';
import { readPaxelWebhook, withPaxelWebhook } from './shipment-metadata';
import { lockShipmentRow } from './shipment-row-lock';
import { lookupProviderStatus } from './shipment-status.mapper';
import { ShipmentSyncService, trackingCacheKey } from './shipment-sync.service';

/** Provider key of Paxel shipments (matches PaxelShipmentProvider.name). */
export const PAXEL_PROVIDER = 'paxel';

/**
 * The acknowledgement body. NEEDS PAXEL CONFIRMATION: the available Paxel example
 * documents the REQUEST only, not what Paxel expects back. An HTTP 2xx is the
 * conventional webhook acknowledgement; the body follows this codebase's other
 * webhook receiver (Midtrans: `{ received: true }`) and is not a Paxel contract.
 */
export type PaxelWebhookBody = { received: true } | { received: false; reason: string };

export interface PaxelWebhookResponse {
  httpStatus: number;
  body: PaxelWebhookBody;
}

/**
 * What processing did (internal - logged, never returned):
 *   transitioned  the shipment moved to a new state (history + order + notification)
 *   recorded      new information stored without a transition
 *   duplicate     nothing new: an equivalent push was already processed
 */
export type PaxelWebhookOutcome = 'transitioned' | 'recorded' | 'duplicate';

export interface PaxelWebhookHeaders {
  contentType?: string;
  /** `X-Paxel-Signature`. Never logged, stored or returned. */
  signature?: string;
}

/** An expected refusal: rolls back the transaction and becomes a failure body. */
class PaxelWebhookRejection extends Error {
  constructor(
    readonly httpStatus: number,
    readonly reason: string,
    readonly action: string,
  ) {
    super(reason);
  }
}

const OK: PaxelWebhookResponse = { httpStatus: 200, body: { received: true } };
const refuse = (httpStatus: number, reason: string): PaxelWebhookResponse => ({ httpStatus, body: { received: false, reason } });

/**
 * Paxel webhook receiver - POST /api/v1/shipments/webhook/paxel.
 *
 * Reuses the existing shipment-status system end to end; it is NOT a parallel one:
 *   - Paxel's `latest_status` goes through the shared ShipmentStatusMapper vocabulary
 *     (lookupProviderStatus) - the same dictionary the Paxel poller uses;
 *   - a transition is decided by the shared rule (domain/shipment-transition) and
 *     applied by ShipmentSyncService.applyTransitionInTx, the step the poller and the
 *     JNE webhook use (status CAS, ShipmentHistory row, legal order advance, customer
 *     notification exactly once) - there is no second notification path;
 *   - everything else Paxel reports is stored in Shipment.metadata.paxel.webhook
 *     (system-owned, stripped from customer responses). Shipment.providerPayload only
 *     ever receives identifiers from here, never the pushed body.
 *
 * Order of checks: enabled → configured → Content-Type → signature header present →
 * the two signed fields → signature valid → full payload → shipment. Nothing about
 * the shipment is looked up, and nothing is written, for an unauthenticated request.
 *
 * Idempotency and ordering (a push may be retried, and may arrive out of order or
 * concurrently with the poller):
 *   - resolution is by airwaybill_code AND provider = paxel; nothing is created;
 *   - each push runs in ONE transaction holding the shipment's row lock;
 *   - a transition only happens on a real, forward, not-older state change, so a
 *     retry is a no-op (no second history row, order event or notification);
 *   - the poller's status CAS loses against a transition the webhook already made.
 */
@Injectable()
export class PaxelWebhookService {
  private readonly logger = new Logger('PaxelWebhookService');
  private readonly config: PaxelWebhookConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ShipmentSyncService,
    @Optional() @Inject(PAXEL_WEBHOOK_CONFIG) config?: PaxelWebhookConfig,
    @Optional() private readonly logs?: LogService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) {
    this.config = config ?? loadPaxelWebhookConfig();
  }

  async handle(body: unknown, headers: PaxelWebhookHeaders): Promise<PaxelWebhookResponse> {
    const receivedAt = new Date();

    if (!this.config.enabled) {
      this.logger.warn({ event: 'paxel.webhook.disabled' });
      return refuse(503, 'Paxel webhook is not enabled');
    }
    if (!this.config.secret) {
      // Env validation requires the secret when enabled; fail closed if it is absent anyway.
      this.logger.error({ event: 'paxel.webhook.not_configured' });
      return refuse(503, 'Paxel webhook is not configured');
    }
    if (!/^application\/json\b/i.test(headers.contentType ?? '')) {
      return refuse(415, 'Content-Type must be application/json');
    }
    if (!headers.signature?.trim()) {
      this.refusal('signature_missing', 'X-Paxel-Signature header is required', undefined);
      return refuse(401, 'X-Paxel-Signature header is required');
    }

    const signed = extractPaxelSignedFields(body);
    if (!signed.ok) {
      this.refusal('validation_failed', signed.reason, undefined);
      return refuse(400, signed.reason);
    }
    const check = verifyPaxelWebhookSignature(headers.signature, signed.airwaybillCode, signed.latestStatus, this.config.secret);
    if (!check.ok) {
      // The claimed AWB (bounded) and the failure kind only - never the header value.
      this.refusal('signature_invalid', `signature ${check.reason}`, signed.airwaybillCode.trim().slice(0, 128));
      return refuse(401, 'invalid X-Paxel-Signature');
    }

    const parsed = parsePaxelWebhook(body);
    if (!parsed.ok) {
      this.refusal('validation_failed', parsed.reason, parsed.airwaybillCode);
      return refuse(400, parsed.reason);
    }

    const payload = parsed.value;
    const base = {
      awb: payload.airwaybillCode,
      paxelStatus: payload.latestStatus,
      webhookFingerprint: payload.fingerprint.slice(0, 16),
      logCount: payload.logs.length,
    };
    this.logger.log({ event: 'paxel.webhook.received', ...base });

    try {
      const result = await this.process(payload, receivedAt);
      this.report(payload, base, result);
      return OK;
    } catch (err) {
      if (err instanceof PaxelWebhookRejection) {
        this.logger.warn({ event: `paxel.webhook.${err.action}`, ...base, reason: err.reason });
        this.logs?.write({
          level: 'WARN',
          module: 'shipment.webhook',
          action: `paxel.${err.action}`,
          message: err.reason,
          metadata: { provider: PAXEL_PROVIDER, awb: payload.airwaybillCode, paxelStatus: payload.latestStatus },
        });
        return refuse(err.httpStatus, err.reason);
      }
      // Unexpected (e.g. database unavailable): the transaction rolled back, nothing was
      // half-written, and a retry is safe. The message only - never the payload.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'paxel.webhook.failed', ...base, error: message });
      this.logs?.write({
        level: 'ERROR',
        module: 'shipment.webhook',
        action: 'paxel.failed',
        message,
        metadata: { provider: PAXEL_PROVIDER, awb: payload.airwaybillCode, paxelStatus: payload.latestStatus },
      });
      return refuse(500, 'internal error');
    }
  }

  /** A refusal before the payload is trusted: correlator and reason only. */
  private refusal(action: string, reason: string, awb: string | undefined): void {
    this.logger.warn({ event: `paxel.webhook.${action}`, awb, reason });
    this.logs?.write({
      level: 'WARN',
      module: 'shipment.webhook',
      action: `paxel.${action}`,
      message: reason,
      metadata: { provider: PAXEL_PROVIDER, awb: awb ?? null },
    });
  }

  private async process(payload: PaxelWebhookPayload, receivedAt: Date) {
    // The AWB is the identity, and only a PAXEL shipment's: an AWB string that belongs
    // to another courier's shipment is never ours to update from here.
    const candidates = await this.prisma.shipment.findMany({
      where: { trackingNumber: payload.airwaybillCode, provider: { equals: PAXEL_PROVIDER, mode: 'insensitive' } },
      select: { id: true, order: { select: { orderNumber: true } } },
      take: 2,
    });
    if (candidates.length === 0) {
      throw new PaxelWebhookRejection(404, 'unknown airwaybill_code: no Paxel shipment has this airwaybill_code', 'unknown_shipment');
    }
    if (candidates.length > 1) {
      throw new PaxelWebhookRejection(409, 'airwaybill_code matches more than one shipment', 'ambiguous_awb');
    }
    // We book Paxel with invoice_number = our order number (PaxelShipmentProvider), so
    // WHEN Paxel echoes it, it must match. Optional: the example carries it, but Paxel
    // has not confirmed it is always our value, so its absence is not a refusal.
    if (payload.invoiceNumber !== undefined && candidates[0].order.orderNumber !== payload.invoiceNumber) {
      throw new PaxelWebhookRejection(409, 'invoice_number does not match the shipment for this airwaybill_code', 'invoice_mismatch');
    }
    const shipmentId = candidates[0].id;

    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize every push for this shipment (and every metadata writer): a
      // concurrent retry waits here, then sees the first one's writes.
      await lockShipmentRow(tx, shipmentId);
      const shipment = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: {
          id: true,
          provider: true,
          service: true,
          status: true,
          trackingNumber: true,
          metadata: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              shippingService: true,
              shippingServiceName: true,
              user: { select: { name: true, email: true, phone: true } },
              address: { select: { phone: true } },
            },
          },
        },
      });
      // Re-checked under the lock: an admin may have edited the AWB meanwhile.
      if (
        !shipment ||
        shipment.trackingNumber !== payload.airwaybillCode ||
        shipment.provider.toLowerCase() !== PAXEL_PROVIDER ||
        (payload.invoiceNumber !== undefined && shipment.order.orderNumber !== payload.invoiceNumber)
      ) {
        throw new PaxelWebhookRejection(409, 'shipment changed while processing; retry', 'shipment_changed');
      }

      const stored = readPaxelWebhook(shipment.metadata);
      // The shared Paxel vocabulary. Undocumented codes (HAPH, FAILED3PL, ...) are
      // undefined here and the rule answers 'unmapped_status': recorded, never applied.
      const target = lookupProviderStatus(PAXEL_PROVIDER, payload.latestStatus);
      const { next, changed, addedLogs } = mergePaxelWebhook(stored, payload, target ?? null, receivedAt);
      const decision: ShipmentTransitionDecision = decideShipmentTransition({
        current: shipment.status,
        target,
        eventTime: payload.eventAt,
        lastAppliedEventTime: stored?.lastAppliedEventAt ?? null,
      });

      let transitioned = false;
      if (decision.apply && target) {
        transitioned = await this.sync.applyTransitionInTx(
          tx,
          shipment,
          target,
          payload.latestStatus,
          // Identifiers only: providerPayload reaches customer order responses, so the
          // pushed body (names, media links, money) must never be written there.
          { source: 'paxel.webhook', airwaybillCode: payload.airwaybillCode, latestStatus: payload.latestStatus, paxelEventAt: payload.eventAt, fingerprint: payload.fingerprint },
          // Our own receipt time: Paxel's log time has no documented zone to convert from.
          receivedAt,
        );
        if (transitioned) {
          next.lastAppliedEventAt = payload.eventAt ?? next.lastAppliedEventAt;
          next.lastAppliedStatus = payload.latestStatus;
          next.lastReceivedAt = receivedAt.toISOString();
        }
      }

      if (changed || transitioned) {
        await tx.shipment.update({ where: { id: shipment.id }, data: { metadata: withPaxelWebhook(shipment.metadata, next) } });
      }

      const outcome: PaxelWebhookOutcome = transitioned ? 'transitioned' : changed ? 'recorded' : 'duplicate';
      return { shipmentId: shipment.id, from: shipment.status, target, decision, outcome, addedLogs };
    });

    // The poller caches Paxel's answer per AWB. After a push, drop it so the next poll
    // asks Paxel afresh instead of reasoning from an answer older than this one.
    if (result.outcome !== 'duplicate') {
      try {
        await this.cache?.del(trackingCacheKey(PAXEL_PROVIDER, payload.airwaybillCode));
      } catch {
        // A cache fault must never fail an accepted push.
      }
    }
    return result;
  }

  private report(
    payload: PaxelWebhookPayload,
    base: Record<string, unknown>,
    result: {
      shipmentId: string;
      from: ShipmentStatus;
      target: ShipmentStatus | undefined;
      decision: ShipmentTransitionDecision;
      outcome: PaxelWebhookOutcome;
      addedLogs: number;
    },
  ): void {
    const line = {
      ...base,
      shipmentId: result.shipmentId,
      outcome: result.outcome,
      transition: result.decision.apply ? 'applied' : result.decision.reason,
      from: result.from,
      to: result.target ?? null,
      addedLogs: result.addedLogs,
      // Names of optional fields that were unusable and dropped - never their values.
      ...(payload.dropped.length ? { droppedFields: payload.dropped } : {}),
    };

    const unmapped = !result.target;
    if (unmapped) {
      // No internal state represents this code; make it visible to operators instead.
      this.logger.warn({ event: 'paxel.webhook.unmapped_status', ...line });
    } else if (result.outcome === 'duplicate') {
      this.logger.log({ event: 'paxel.webhook.duplicate', ...line });
    } else {
      this.logger.log({ event: 'paxel.webhook.processed', ...line });
    }

    this.logs?.write({
      level: unmapped || payload.dropped.length ? 'WARN' : 'INFO',
      module: 'shipment.webhook',
      action: unmapped ? 'paxel.unmapped_status' : `paxel.${result.outcome}`,
      message: `Paxel ${payload.latestStatus}: ${result.outcome} (${line.transition})`,
      shipmentId: result.shipmentId,
      metadata: {
        provider: PAXEL_PROVIDER,
        awb: payload.airwaybillCode,
        paxelStatus: payload.latestStatus,
        transition: line.transition,
        from: result.from,
        to: result.target ?? null,
        addedLogs: result.addedLogs,
        ...(payload.dropped.length ? { droppedFields: payload.dropped } : {}),
      },
    });
  }
}
