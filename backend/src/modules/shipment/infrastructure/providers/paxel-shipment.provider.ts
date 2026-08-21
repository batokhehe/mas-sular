import { Inject, Injectable, Logger } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { PermanentError } from '../../../shipping/domain/shipping-errors';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../../../shipping/infrastructure/http/shipping-http-client';
import { SHIPPING_CONFIG, ShippingConfig } from '../../../shipping/shipping.config';
import { lookupProviderStatus } from '../../shipment-status.mapper';
import { paxelCancelSignature } from './paxel-signature';
import {
  CreateShipmentInput,
  CreateShipmentResult,
  RawTrackingResult,
  ShipmentProvider,
  ShipmentTrackingResult,
} from '../../domain/shipment-provider.interface';

const CREATE_PATH = '/v1/shipments';
/**
 * Real Paxel paths, from the Postman collection. The base URL already carries
 * `/v1`, so these are appended bare — and tracking is a shipment lookup, not a
 * separate tracking service: the previously guessed `/v1/tracking/:no` does not
 * exist.
 */
const SHIPMENTS_PATH = '/shipments';

/**
 * Sent when a caller does not supply one. Paxel requires a non-empty reason and
 * feeds its first two characters into the signature, so it can never be blank.
 */
export const DEFAULT_CANCELLATION_REASON = 'dibatalkan oleh penjual';

interface PaxelCreateResponse {
  data?: { id?: string; tracking_number?: string; status?: string };
}

/**
 * Paxel's status vocabulary lives in ShipmentStatusMapper, not here — one
 * dictionary, one place to update. Anything it does not recognise becomes the
 * caller's fallback rather than a guess.
 */
function mapStatus(raw: string | undefined, fallback: ShipmentStatus): ShipmentStatus {
  return lookupProviderStatus('paxel', raw ?? '') ?? fallback;
}

/** Real Paxel fulfillment integration (create / cancel / track). */
@Injectable()
export class PaxelShipmentProvider implements ShipmentProvider {
  readonly name = 'paxel';
  private readonly logger = new Logger('PaxelShipmentProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

  private get cfg() {
    return this.config.paxel;
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new PermanentError('Paxel fulfillment is disabled (PAXEL_ENABLED=false)', this.name);
    }
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${CREATE_PATH}`,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference_no: input.orderNumber,
          service_type: input.service,
          weight: input.weightGram,
          origin: {
            name: input.origin.name,
            postal_code: input.origin.postalCode,
            latitude: input.origin.latitude,
            longitude: input.origin.longitude,
          },
          destination: {
            name: input.destination.name,
            phone: input.destination.phone,
            address: input.destination.addressDetail,
            postal_code: input.destination.postalCode,
            latitude: input.destination.latitude,
            longitude: input.destination.longitude,
          },
        }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: {
        provider: this.name,
        origin: input.origin.postalCode,
        destination: input.destination.postalCode,
        service: input.service,
      },
    });

    const parsed = safeParse<PaxelCreateResponse>(text);
    const trackingNumber = parsed?.data?.tracking_number;
    const providerShipmentId = parsed?.data?.id;
    if (!trackingNumber || !providerShipmentId) {
      throw new PermanentError('Paxel response missing tracking_number/id', this.name);
    }
    return {
      trackingNumber,
      providerShipmentId,
      status: mapStatus(parsed?.data?.status, ShipmentStatus.CREATED),
      rawPayload: parsed ?? text,
    };
  }

  /**
   * POST /shipments/:airwaybill_code/cancel
   *
   * The identifier is Paxel's airwaybill code — for Paxel that IS the provider
   * shipment id, since create returns only `airwaybill_code`.
   *
   * Errors propagate. executeShippingRequest throws PermanentError on 4xx and
   * TransientError on 5xx/timeout/network, and a cancellation that Paxel did
   * not accept must never be reported to the caller as success.
   */
  async cancelShipment(airwaybillCode: string, reason: string = DEFAULT_CANCELLATION_REASON): Promise<void> {
    this.assertEnabled();
    const cancellationReason = reason.trim() || DEFAULT_CANCELLATION_REASON;
    await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${SHIPMENTS_PATH}/${encodeURIComponent(airwaybillCode)}/cancel`,
      init: {
        method: 'POST',
        headers: {
          'X-Paxel-API-Key': this.cfg.apiKey ?? '',
          'X-Paxel-Signature': paxelCancelSignature(airwaybillCode, cancellationReason, this.cfg.apiSecret ?? ''),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancellation_reason: cancellationReason }),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      // No AWB, no reason, no signature in the log context.
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'CANCEL' },
    });
  }

  /**
   * GET /shipments/:airwaybill_code
   *
   * Paxel reports the current state in `data.latest_status` — a short code such
   * as PDO or RTP, not a word. An unrecognised code degrades to UNKNOWN here
   * rather than to a plausible-looking guess like IN_TRANSIT, which would move a
   * shipment forward on no evidence.
   */
  async trackShipment(trackingNumber: string): Promise<ShipmentTrackingResult> {
    const { latestStatus, payload } = await this.fetchShipment(trackingNumber);
    return { status: mapStatus(latestStatus, ShipmentStatus.UNKNOWN), rawPayload: payload };
  }

  /** Raw provider status for the ShipmentStatusMapper (no internal mapping here). */
  async trackShipmentRaw(trackingNumber: string): Promise<RawTrackingResult> {
    const { latestStatus, payload } = await this.fetchShipment(trackingNumber);
    return { providerStatus: latestStatus, rawPayload: payload };
  }

  /** One shipment lookup, shared by both tracking entry points. */
  private async fetchShipment(airwaybillCode: string): Promise<{ latestStatus: string; payload: unknown }> {
    this.assertEnabled();
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${SHIPMENTS_PATH}/${encodeURIComponent(airwaybillCode)}`,
      init: {
        method: 'GET',
        headers: { 'X-Paxel-API-Key': this.cfg.apiKey ?? '' },
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
    });
    const parsed = safeParse<PaxelShipmentResponse>(text);
    return { latestStatus: parsed?.data?.latest_status ?? '', payload: parsed ?? text };
  }
}

/** Only the field tracking reads; the rest of Paxel's detail payload is snapshotted as-is. */
interface PaxelShipmentResponse {
  data?: { latest_status?: string };
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
