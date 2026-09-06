import { Inject, Injectable, Logger } from '@nestjs/common';
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

const GENERATE_PATH = '/tracing/api/generatecnote';
const CANCEL_PATH = '/tracing/api/cancelcnote';
const TRACK_PATH = '/tracing/api/list/v1/cnote';

interface JneGenerateResponse {
  detail?: Array<{ cnote_no?: string; status?: string }>;
  cnote?: { cnote_no?: string };
  error?: string;
}

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
   * 61AG.3.31: JNE is now booked BY the application, automatically, as soon as a
   * payment settles. This reverses PAXELBOX-38, where the operator arranged the
   * consignment out-of-band and typed the cnote in by hand.
   *
   * The reversal costs nothing structurally because `createShipment` below was
   * deliberately kept and stayed a truthful implementation of the JNE contract
   * throughout the manual period: it needs no human input, deriving everything
   * from the order (number, service, weight, destination) and configuration
   * (JNE_ORIGIN_CODE), and it returns the cnote as both trackingNumber and
   * providerShipmentId.
   *
   * Enabling this makes JNE_ORIGIN_CODE load-bearing for the first time.
   * JneOriginBootValidator already refuses to boot when JNE_ENABLED=true and the
   * code is absent, and validates it against the ORIGIN master when that master
   * has been imported — but it only WARNS when the master is missing, so a wrong
   * code surfaces as a booking failure (shipment FAILED, retry available) rather
   * than at startup.
   */
  readonly supportsAutomaticBooking = true;
  private readonly logger = new Logger('JneShipmentProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(@Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig) {}

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

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    this.assertEnabled();
    const weightKg = Math.max(1, Math.ceil(input.weightGram / 1000));
    const form = this.auth({
      order_no: input.orderNumber,
      service_code: input.service,
      weight: String(weightKg),
      origin_code: this.cfg.originCode ?? '',
      destination_zip: input.destination.postalCode,
      receiver_name: input.destination.name,
      receiver_phone: input.destination.phone ?? '',
      receiver_addr: input.destination.addressDetail ?? '',
    });

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${GENERATE_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: {
        provider: this.name,
        origin: this.cfg.originCode ?? '-',
        destination: input.destination.postalCode,
        service: input.service,
      },
    });

    const parsed = safeParse<JneGenerateResponse>(text);
    const cnote = parsed?.detail?.[0]?.cnote_no ?? parsed?.cnote?.cnote_no;
    if (!cnote) {
      throw new PermanentError(`JNE did not return a cnote (${parsed?.error ?? 'unknown'})`, this.name);
    }
    return {
      trackingNumber: cnote,
      providerShipmentId: cnote,
      status: mapStatus(parsed?.detail?.[0]?.status, ShipmentStatus.CREATED),
      rawPayload: parsed ?? text,
    };
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
