import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LogService } from '../../infrastructure/logging/log.service';
import {
  currentJneRecord,
  JNE_RECORD_ONLY_STATUSES,
  JneWebhookPayload,
  mergeJneWebhook,
  parseJneWebhook,
} from './domain/jne-webhook';
import { decideShipmentTransition, ShipmentTransitionDecision } from './domain/shipment-transition';
import { JNE_WEBHOOK_CONFIG, JneWebhookConfig, loadJneWebhookConfig } from './jne-webhook.config';
import { readJneWebhook, withJneWebhook } from './shipment-metadata';
import { lockShipmentRow } from './shipment-row-lock';
import { lookupProviderStatus } from './shipment-status.mapper';
import { ShipmentSyncService, trackingCacheKey } from './shipment-sync.service';

/** Provider key of JNE shipments (matches JneShipmentProvider.name). */
export const JNE_PROVIDER = 'jne';

/** The response body JNE's V2 documentation specifies. Nothing else is returned. */
export type JneWebhookBody = { status: true } | { status: false; reason: string };

export interface JneWebhookResponse {
  httpStatus: number;
  body: JneWebhookBody;
}

/**
 * What processing did (internal - logged, never returned):
 *   transitioned  the shipment moved to a new state (history + order + notification)
 *   recorded      new information stored (events, figures) without a transition
 *   duplicate     nothing new: an equivalent webhook was already processed
 */
export type JneWebhookOutcome = 'transitioned' | 'recorded' | 'duplicate';

/** An expected refusal: rolls back the transaction and becomes the documented error body. */
class JneWebhookRejection extends Error {
  constructor(
    readonly httpStatus: number,
    readonly reason: string,
    readonly action: string,
  ) {
    super(reason);
  }
}

const OK: JneWebhookResponse = { httpStatus: 200, body: { status: true } };

/**
 * JNE Webhook Status V2 receiver.
 *
 * Reuses the existing shipment-status system end to end - it is NOT a parallel one:
 *   - JNE's summary status is mapped through the shared ShipmentStatusMapper
 *     vocabulary (lookupProviderStatus);
 *   - a transition goes through ShipmentSyncService.applyTransitionInTx, the same
 *     step the tracking poller uses (status CAS, ShipmentHistory row, legal order
 *     advance, customer notification exactly once);
 *   - everything else JNE reports is stored in Shipment.metadata.jne.webhook.
 *
 * Idempotency and ordering (JNE retries, and may deliver out of order):
 *   - resolution is by AWB, cross-checked against order_id; nothing is created;
 *   - each webhook runs in ONE transaction holding a row lock on the shipment, so
 *     concurrent deliveries for the same AWB serialize;
 *   - history events carry a deterministic fingerprint and are stored once;
 *   - a transition only happens on a real, forward, not-older state change (the
 *     shared rule in domain/shipment-transition.ts, also used by the pollers), so a
 *     retry is a no-op: no second history row, order event or notification.
 *
 * JNE's `history[].date` has no documented time zone: it is stored verbatim and
 * compared only with other JNE dates. ShipmentHistory.changedAt is OUR receipt time.
 */
@Injectable()
export class JneWebhookService {
  private readonly logger = new Logger('JneWebhookService');
  private readonly config: JneWebhookConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ShipmentSyncService,
    @Optional() @Inject(JNE_WEBHOOK_CONFIG) config?: JneWebhookConfig,
    @Optional() private readonly logs?: LogService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) {
    this.config = config ?? loadJneWebhookConfig();
  }

  async handle(body: unknown): Promise<JneWebhookResponse> {
    const receivedAt = new Date();

    if (!this.config.enabled) {
      this.logger.warn({ event: 'jne.webhook.disabled' });
      return { httpStatus: 503, body: { status: false, reason: 'JNE webhook is not enabled' } };
    }

    const parsed = parseJneWebhook(body);
    if (!parsed.ok) {
      // Correlators and the reason only - never the payload.
      this.logger.warn({ event: 'jne.webhook.validation_failed', awb: parsed.awb, orderId: parsed.orderId, reason: parsed.reason });
      this.logs?.write({
        level: 'WARN',
        module: 'shipment.webhook',
        action: 'jne.validation_failed',
        message: parsed.reason,
        metadata: { provider: JNE_PROVIDER, awb: parsed.awb ?? null, jneOrderId: parsed.orderId ?? null },
      });
      return { httpStatus: 400, body: { status: false, reason: parsed.reason } };
    }

    const payload = parsed.value;
    const base = {
      awb: payload.awb,
      orderId: payload.orderId,
      jneStatus: payload.status,
      webhookFingerprint: payload.fingerprint.slice(0, 16),
      historyCount: payload.history.length,
    };
    this.logger.log({ event: 'jne.webhook.received', ...base });

    try {
      const result = await this.process(payload, receivedAt);
      this.report(payload, base, result);
      return OK;
    } catch (err) {
      if (err instanceof JneWebhookRejection) {
        this.logger.warn({ event: `jne.webhook.${err.action}`, ...base, reason: err.reason });
        this.logs?.write({
          level: 'WARN',
          module: 'shipment.webhook',
          action: `jne.${err.action}`,
          message: err.reason,
          metadata: { provider: JNE_PROVIDER, awb: payload.awb, jneOrderId: payload.orderId, jneStatus: payload.status },
        });
        return { httpStatus: err.httpStatus, body: { status: false, reason: err.reason } };
      }
      // Unexpected (e.g. database unavailable): the transaction rolled back, nothing
      // was half-written, and JNE may safely retry. The message only - no payload.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'jne.webhook.failed', ...base, error: message });
      this.logs?.write({
        level: 'ERROR',
        module: 'shipment.webhook',
        action: 'jne.failed',
        message,
        metadata: { provider: JNE_PROVIDER, awb: payload.awb, jneOrderId: payload.orderId, jneStatus: payload.status },
      });
      return { httpStatus: 500, body: { status: false, reason: 'internal error' } };
    }
  }

  private async process(payload: JneWebhookPayload, receivedAt: Date) {
    // The AWB is the identity; order_id only confirms it. JNE shipments only - an AWB
    // that belongs to another courier's shipment is not ours to update.
    const candidates = await this.prisma.shipment.findMany({
      where: { trackingNumber: payload.awb, provider: { equals: JNE_PROVIDER, mode: 'insensitive' } },
      select: { id: true, order: { select: { orderNumber: true } } },
      take: 2,
    });
    if (candidates.length === 0) {
      throw new JneWebhookRejection(404, 'unknown awb: no JNE shipment has this awb', 'unknown_shipment');
    }
    if (candidates.length > 1) {
      throw new JneWebhookRejection(409, 'awb matches more than one shipment', 'ambiguous_awb');
    }
    // We book JNE with order_no = our order number, so JNE's order_id must echo it.
    // A mismatch is never "corrected": it could be another order's shipment.
    if (candidates[0].order.orderNumber !== payload.orderId) {
      throw new JneWebhookRejection(409, 'order_id does not match the shipment for this awb', 'order_mismatch');
    }
    const shipmentId = candidates[0].id;

    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize every webhook for this shipment: a concurrent retry waits here and
      // then sees the first one's writes, so it can only ever be a duplicate.
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
        shipment.trackingNumber !== payload.awb ||
        shipment.provider.toLowerCase() !== JNE_PROVIDER ||
        shipment.order.orderNumber !== payload.orderId
      ) {
        throw new JneWebhookRejection(409, 'shipment changed while processing; retry', 'shipment_changed');
      }

      const stored = readJneWebhook(shipment.metadata);
      const prev = currentJneRecord(stored);
      const { next, addedEvents, changed } = mergeJneWebhook(stored, payload, receivedAt);

      // FAILED PICKUP and SHIPMENT PROBLEM have no internal state (see
      // JNE_RECORD_ONLY_STATUSES): lookup is undefined and the rule answers
      // 'unmapped_status' - recorded, never a transition.
      const target = lookupProviderStatus(JNE_PROVIDER, payload.status);
      const decision: ShipmentTransitionDecision = decideShipmentTransition({
        current: shipment.status,
        target,
        eventTime: payload.eventAt,
        lastAppliedEventTime: prev?.lastAppliedEventAt ?? null,
      });

      let transitioned = false;
      if (decision.apply && target) {
        transitioned = await this.sync.applyTransitionInTx(
          tx,
          shipment,
          target,
          payload.status,
          // Latest-status snapshot, as the poller stores: identifiers only. The full
          // JNE detail lives in metadata.jne.webhook.
          { source: 'jne.webhook', awb: payload.awb, status: payload.status, jneEventDate: payload.eventAt, fingerprint: payload.fingerprint },
          // Our own receipt time: JNE's date has no documented zone to convert from.
          receivedAt,
        );
        if (transitioned) {
          next.lastAppliedEventAt = payload.eventAt ?? next.lastAppliedEventAt;
          next.lastAppliedStatus = payload.status;
          next.lastReceivedAt = receivedAt.toISOString();
        }
      }

      if (changed || transitioned) {
        await tx.shipment.update({ where: { id: shipment.id }, data: { metadata: withJneWebhook(shipment.metadata, next) } });
      }

      const outcome: JneWebhookOutcome = transitioned ? 'transitioned' : changed ? 'recorded' : 'duplicate';
      return { shipmentId: shipment.id, from: shipment.status, target, decision, outcome, addedEvents };
    });

    // The tracking poller caches JNE's answer per AWB. After a push, drop it so the
    // next poll asks JNE afresh instead of reasoning from an answer older than this.
    if (result.outcome !== 'duplicate') {
      try {
        await this.cache?.del(trackingCacheKey(JNE_PROVIDER, payload.awb));
      } catch {
        // A cache fault must never fail an accepted webhook.
      }
    }
    return result;
  }

  private report(
    payload: JneWebhookPayload,
    base: Record<string, unknown>,
    result: {
      shipmentId: string;
      from: ShipmentStatus;
      target: ShipmentStatus | undefined;
      decision: ShipmentTransitionDecision;
      outcome: JneWebhookOutcome;
      addedEvents: number;
    },
  ): void {
    const line = {
      ...base,
      shipmentId: result.shipmentId,
      outcome: result.outcome,
      transition: result.decision.apply ? 'applied' : result.decision.reason,
      from: result.from,
      to: result.target ?? null,
      addedEvents: result.addedEvents,
      // Names of optional fields that were unusable and dropped - never their values.
      ...(payload.dropped.length ? { droppedFields: payload.dropped } : {}),
    };

    const recordOnly = JNE_RECORD_ONLY_STATUSES.includes(payload.status);
    const attentionEvent = payload.status === 'FAILED PICKUP' ? 'failed_pickup' : 'shipment_problem';
    if (recordOnly) {
      // No internal state represents it; make it visible to operators instead.
      this.logger.warn({ event: `jne.webhook.${attentionEvent}`, ...line });
    } else if (result.outcome === 'duplicate') {
      this.logger.log({ event: 'jne.webhook.duplicate', ...line });
    } else {
      this.logger.log({ event: 'jne.webhook.processed', ...line });
    }

    this.logs?.write({
      level: recordOnly || payload.dropped.length ? 'WARN' : 'INFO',
      module: 'shipment.webhook',
      action: recordOnly ? `jne.${attentionEvent}` : `jne.${result.outcome}`,
      message: `JNE ${payload.status}: ${result.outcome} (${line.transition})`,
      shipmentId: result.shipmentId,
      metadata: {
        provider: JNE_PROVIDER,
        awb: payload.awb,
        jneOrderId: payload.orderId,
        jneStatus: payload.status,
        transition: line.transition,
        from: result.from,
        to: result.target ?? null,
        addedEvents: result.addedEvents,
        ...(payload.dropped.length ? { droppedFields: payload.dropped } : {}),
      },
    });
  }
}
