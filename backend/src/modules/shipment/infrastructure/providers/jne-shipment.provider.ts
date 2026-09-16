import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { IntegrationLogService } from '../../../../infrastructure/integration-log/integration-log.service';
import { safeRecord } from '../../../../infrastructure/integration-log/safe-record';
import { sanitizeErrorText, sanitizePayload } from '../../../../infrastructure/integration-log/integration-log.sanitizer';
import { JneDestinationResolver } from '../../../shipping/infrastructure/jne-destination.resolver';
import {
  buildJnePickupCashlessFields,
  JnePickupCashlessFields,
  JnePickupCashlessResult,
  parseJnePickupCashlessResponse,
  serializeJnePickupCashless,
} from './jne-pickup-cashless';
import { ShipmentStatus } from '@prisma/client';
import { PermanentError } from '../../../shipping/domain/shipping-errors';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../../../shipping/infrastructure/http/shipping-http-client';
import { SHIPPING_CONFIG, ShippingConfig, assertJneEnvironment } from '../../../shipping/shipping.config';
import {
  CreateShipmentInput,
  CreateShipmentResult,
  RawTrackingResult,
  ShipmentProvider,
  ShipmentTrackingResult,
} from '../../domain/shipment-provider.interface';

/**
 * Shipment creation: JNE instructed the project to use `/pickupcashless`.
 * `/tracing/api/generatecnote` is no longer used for booking.
 */
export const PICKUP_CASHLESS_PATH = '/pickupcashless';
const CANCEL_PATH = '/tracing/api/cancelcnote';
const TRACK_PATH = '/tracing/api/list/v1/cnote';

/** Integration-log operation, in JNE's own endpoint vocabulary (like CANCEL_CNOTE). */
export const JNE_PICKUP_CASHLESS_OPERATION = 'PICKUP_CASHLESS';

/** Longest JNE rejection reason carried into a thrown error / persisted failure. */
const JNE_REASON_MAX = 300;

function mapStatus(raw: string | undefined, fallback: ShipmentStatus): ShipmentStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'CREATED':
      return ShipmentStatus.CREATED;
    case 'PICKED_UP':
      return ShipmentStatus.PICKED_UP;
    case 'ON PROCESS':
    case 'IN_TRANSIT':
      return ShipmentStatus.IN_TRANSIT;
    case 'DELIVERED':
      return ShipmentStatus.DELIVERED;
    case 'CANCELLED':
      return ShipmentStatus.CANCELLED;
    case 'FAILED':
      return ShipmentStatus.FAILED;
    default:
      return fallback;
  }
}

/** Real JNE fulfillment integration (create / cancel / track). */
@Injectable()
export class JneShipmentProvider implements ShipmentProvider {
  readonly name = 'jne';

  /**
   * 61AG.3.31: JNE is booked BY the application as soon as a payment settles, so the
   * shared lifecycle claims the shipment and calls createShipment. JNE instructed
   * the project to book via `/pickupcashless`, and confirmed that it returns the
   * cnote synchronously (`detail[0].cnote_no`), so the lifecycle is unchanged:
   * cnote -> trackingNumber/providerShipmentId -> SHIPPED, in one transaction.
   *
   * JneOriginBootValidator still refuses to boot when JNE_ENABLED=true and
   * JNE_ORIGIN_CODE is absent; env.validation additionally requires the
   * /pickupcashless master data (JNE_PICKUP_*, JNE_SHIPPER_*, JNE_BRANCH,
   * JNE_CUST_ID, JNE_MERCHANT_ID, JNE_TYPE).
   */
  readonly supportsAutomaticBooking = true;
  private readonly logger = new Logger('JneShipmentProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(
    @Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig,
    // P1 integration logging. Optional — absent, nothing is recorded.
    @Optional() private readonly integrationLogs?: IntegrationLogService,
    // The SAME verified district -> JNE destination mapping the quote uses. Optional
    // only so existing tests construct the provider as before; a booking without it
    // refuses, because DESTINATION_CODE must never fall back to a postal code.
    @Optional() private readonly destinations?: JneDestinationResolver,
  ) {}

  /** Business context for one external call; the transport owns the rest. */
  private integration(operation: string, extra: { orderId?: string | null; correlationId?: string | null } = {}) {
    return {
      provider: IntegrationProvider.JNE,
      operation,
      recorder: this.integrationLogs,
      orderId: extra.orderId ?? null,
      correlationId: extra.correlationId ?? null,
    };
  }

  private get cfg() {
    return this.config.jne;
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new PermanentError('JNE fulfillment is disabled (JNE_ENABLED=false)', this.name);
    }
    // Re-checked per call, not only at boot (PAXELBOX-61K). Tracking and cancel are
    // the paths that spend this base URL against real, hand-entered cnotes, and a
    // SHIPPING_CONFIG wired directly - as several tests and any future module may do -
    // never passes through a module factory. PermanentError so the tracking worker
    // records a misconfiguration instead of retrying it forever.
    try {
      assertJneEnvironment(this.cfg);
    } catch (err) {
      throw new PermanentError(err instanceof Error ? err.message : String(err), this.name);
    }
  }

  private auth(extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({
      username: this.cfg.username ?? '',
      api_key: this.cfg.apiKey ?? '',
      ...extra,
    });
  }

  /**
   * Book through `/pickupcashless` (JNE's instruction) and return the cnote JNE
   * issued - never an identifier of our own.
   *
   * 1. Build and validate every documented field. Any problem (pickup configuration,
   *    unmapped destination, unmeasured weight, no recorded pickup slot) refuses
   *    here, BEFORE a request exists - nothing is sent and nothing is logged as sent.
   * 2. Send ONCE (`maxRetry: 0`): a timeout can land after JNE accepted the pickup.
   * 3. Interpret the body against the CONFIRMED contract only:
   *      success         -> cnote_no is the trackingNumber AND providerShipmentId
   *      provider error  -> PermanentError carrying JNE's reason (HTTP 200 included)
   *      malformed       -> PermanentError; nothing is concluded from the body
   *
   * The application outcome is recorded next to the HTTP attempt under the same
   * operationId: OK, REJECTED (JNE refused) or PARSE_FAILED.
   */
  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const fields = await this.buildPickupCashlessFields(input);

    const startedAt = Date.now();
    const { status, text, operationId } = await this.sendPickupCashless(fields, {
      orderId: input.orderId,
      correlationId: input.orderNumber,
    });
    const result = parseJnePickupCashlessResponse(text);
    this.recordPickupOutcome(result, { operationId, status, text, startedAt, orderId: input.orderId, orderNumber: input.orderNumber });

    if (result.kind === 'success') {
      return {
        trackingNumber: result.cnote,
        providerShipmentId: result.cnote,
        status: ShipmentStatus.CREATED,
        // Snapshotted onto the shipment; the confirmed success body holds no PII, and
        // the same sanitizer as the integration log keeps it that way if JNE adds fields.
        rawPayload: sanitizePayload(result.payload),
      };
    }
    if (result.kind === 'provider_error') {
      throw new PermanentError(`JNE rejected the pickup: ${this.safeReason(result.reason)}`, this.name);
    }
    throw new PermanentError(`JNE /pickupcashless returned an unexpected response: ${result.problem}`, this.name);
  }

  /** JNE's own words, with the integration-log policy applied and a bounded length. */
  private safeReason(reason: string): string {
    return sanitizeErrorText(reason, JNE_REASON_MAX) ?? 'no reason given';
  }

  /** The application-outcome record for one /pickupcashless exchange. Best-effort. */
  private recordPickupOutcome(
    result: JnePickupCashlessResult,
    ctx: { operationId: string; status: number; text: string; startedAt: number; orderId: string; orderNumber: string },
  ): void {
    const outcome =
      result.kind === 'success'
        ? IntegrationOutcome.OK
        : result.kind === 'provider_error'
          ? IntegrationOutcome.REJECTED
          : IntegrationOutcome.PARSE_FAILED;
    safeRecord(
      this.integrationLogs,
      {
        provider: IntegrationProvider.JNE,
        operation: JNE_PICKUP_CASHLESS_OPERATION,
        direction: IntegrationDirection.OUTBOUND,
        operationId: ctx.operationId,
        orderId: ctx.orderId,
        correlationId: result.kind === 'success' ? result.cnote : ctx.orderNumber,
        method: 'POST',
        endpoint: `${this.cfg.baseUrl}${PICKUP_CASHLESS_PATH}`,
        httpStatus: ctx.status,
        durationMs: Date.now() - ctx.startedAt,
        applicationOutcome: outcome,
        errorClass: result.kind === 'provider_error' ? 'rejected' : result.kind === 'malformed' ? 'parse_failed' : null,
        errorMessage: result.kind === 'provider_error' ? result.reason : result.kind === 'malformed' ? result.problem : null,
        responseBody: ctx.text,
      },
      (err) => this.logger.warn({ event: 'integration_log.record_failed', reason: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Every documented `/pickupcashless` field for this booking, validated. Never sends. */
  async buildPickupCashlessFields(input: CreateShipmentInput): Promise<JnePickupCashlessFields> {
    if (!this.destinations) {
      throw new PermanentError(
        'JNE booking refused before sending: the JNE destination resolver is not available (postal code is never used as a fallback)',
        this.name,
      );
    }
    const destinationCode = await this.destinations.resolve(input.destinationDistrictId ?? undefined);
    return buildJnePickupCashlessFields(
      {
        orderNumber: input.orderNumber,
        service: input.service,
        goodsAmount: input.goodsAmount,
        destinationCode,
        pickupAtIso: input.recordedPickupAtIso,
        receiver: {
          name: input.destination.name,
          phone: input.destination.phone,
          addressDetail: input.destination.addressDetail,
          village: input.destination.village,
          district: input.destination.district,
          city: input.destination.city,
          postalCode: input.destination.postalCode,
          province: input.destination.province,
        },
        items: (input.items ?? []).map((item) => ({ name: item.name, quantity: item.quantity, weightGram: item.weightGram })),
      },
      this.cfg.pickup,
      this.cfg.originCode,
    );
  }

  /**
   * Send ONE `/pickupcashless` request through the shared shipping transport, with
   * integration logging (operation PICKUP_CASHLESS, one record per attempt, request
   * and response sanitized - credentials and receiver PII never persisted).
   *
   * `maxRetry: 0`, always: a timeout can land AFTER JNE has accepted the pickup, and
   * an automatic resend would request a second one. No custom retry exists.
   *
   * Returns the raw status, body and operationId; createShipment interprets the body
   * (parseJnePickupCashlessResponse) and records the application outcome under the
   * same operationId.
   */
  async sendPickupCashless(
    fields: JnePickupCashlessFields,
    context: { orderId?: string | null; correlationId?: string | null } = {},
  ): Promise<{ status: number; text: string; operationId: string }> {
    this.assertEnabled();
    return executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${PICKUP_CASHLESS_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: serializeJnePickupCashless({ username: this.cfg.username, apiKey: this.cfg.apiKey }, fields),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: 0,
      logger: this.logger,
      logBase: {
        provider: this.name,
        origin: fields.ORIGIN_CODE,
        destination: fields.DESTINATION_CODE,
        service: fields.SERVICE_CODE,
      },
      integration: this.integration(JNE_PICKUP_CASHLESS_OPERATION, {
        orderId: context.orderId ?? null,
        correlationId: context.correlationId ?? fields.ORDER_ID,
      }),
    });
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    this.assertEnabled();
    await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${CANCEL_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ cnote_no: providerShipmentId }).toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'CANCEL' },
      integration: this.integration('CANCEL_CNOTE', { correlationId: providerShipmentId }),
    });
  }

  async trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ awb: trackingNumber }).toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
      integration: this.integration('TRACK', { correlationId: trackingNumber }),
    });
    const parsed = safeParse<{ cnote?: { pod_status?: string } }>(text);
    return { status: mapStatus(parsed?.cnote?.pod_status, ShipmentStatus.IN_TRANSIT), rawPayload: parsed ?? text };
  }

  /** Raw provider status for the ShipmentStatusMapper (no internal mapping here). */
  async trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: this.auth({ awb: trackingNumber }).toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
      integration: this.integration('TRACK', { correlationId: trackingNumber }),
    });
    const parsed = safeParse<{ cnote?: { pod_status?: string } }>(text);
    return { providerStatus: parsed?.cnote?.pod_status ?? '', rawPayload: parsed ?? text };
  }
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
