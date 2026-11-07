import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { IntegrationLogService } from '../../../../infrastructure/integration-log/integration-log.service';
import { ShippingProvider, ShippingQuote, ShippingRateRequest, TrackingResult } from '../../domain/shipping-provider.interface';
import { JneDestinationResolver } from '../jne-destination.resolver';
import { SHIPPING_CONFIG, ShippingConfig, assertJneEnvironment } from '../../shipping.config';
import {
  defaultShippingHttpClient,
  executeShippingRequest,
  ShippingHttpClient,
} from '../http/shipping-http-client';

const TRACK_PATH = '/tracing/api/list/v1/cnote';

/** JNE's own tariff endpoint, relative to the configured JNE base URL. */
const PRICEDEV_PATH = '/tracing/api/pricedev';

/**
 * JNE's tariff response. Every field arrives as a STRING or null - `price` and
 * both ETD bounds included - so nothing here is typed as a number.
 */
interface JnePricedevResponse {
  price?: Array<{
    origin_name?: string | null;
    destination_name?: string | null;
    service_display?: string | null;
    service_code?: string | null;
    goods_type?: string | null;
    currency?: string | null;
    price?: string | number | null;
    etd_from?: string | null;
    etd_thru?: string | null;
    times?: string | null;
  }>;
  /** JNE reports failure in the body, not the status line: {"error":"...","status":false}. */
  error?: string;
  status?: boolean;
}

/** A JNE tariff price as a plain decimal string: digits, optionally a fractional part. */
const JNE_PRICE_TEXT = /^\d+(\.\d+)?$/;

/**
 * JNE `price` → whole IDR, or null when it is not a usable price.
 *
 * A quote a customer can select must carry a real, positive price, so zero, a
 * negative, an empty or blank string, null, a non-numeric string (including
 * "NaN", "Infinity", hex and exponent forms), a non-finite number and anything
 * that rounds to Rp0 are all rejected. Nothing is ever coerced to zero: `Number("")`
 * is 0, which is exactly how an empty price used to become a free option.
 */
export function parseJnePrice(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (!JNE_PRICE_TEXT.test(text)) return null;
    value = Number(text);
  } else {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  const idr = Math.round(value);
  return idr > 0 ? idr : null;
}

/**
 * JNE Trucking (JTR) service codes. Mas Sular does not offer trucking to customers.
 *
 * Identified by `service_code`, never by `service_display`. The live RATE responses
 * for every active mapping (Rounds 49-54) return trucking as `JTR23`, `JTR<130`,
 * `JTR>130` and `JTR>200`, plus the city-courier variant `CTCJTR23`, whose
 * `service_display` is "JTR". `CTC23`, `CTCYES23` and `CTCSPS23` are NOT trucking.
 * The pattern is anchored at the start of the code, so a later suffix or weight band
 * (`JTR25`, `JTR>300`) is hidden too, and no other code that merely contains the
 * letters is affected.
 */
const JNE_TRUCKING_SERVICE_CODE = /^(?:CTC)?JTR/i;

/** True when a JNE service code is JNE Trucking (any variant), which checkout never offers. */
export function isJneTruckingService(serviceCode: string): boolean {
  return JNE_TRUCKING_SERVICE_CODE.test(serviceCode.trim());
}

/** The value when it is a string, otherwise null: JNE sends text, and a row of another shape must not throw. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Real JNE courier integration. Authenticates with username + api_key (JNE's
 * form-encoded tariff API), requests a quotation over HTTP with timeout + retry,
 * classifies errors, maps the response to ShippingQuote, and logs without secrets.
 * When disabled it contributes no quotes.
 */
@Injectable()
export class JneProvider implements ShippingProvider {
  readonly name = 'jne';
  private readonly logger = new Logger('JneProvider');
  private http: ShippingHttpClient = defaultShippingHttpClient;

  constructor(
    @Inject(SHIPPING_CONFIG) private readonly config: ShippingConfig,
    private readonly destinations: JneDestinationResolver,
    // P1 integration logging. Optional — absent, nothing is recorded.
    @Optional() private readonly integrationLogs?: IntegrationLogService,
  ) {}

  /** Business context for one external call; the transport owns the rest. */
  private integration(operation: string, correlationId?: string | null) {
    return {
      provider: IntegrationProvider.JNE,
      operation,
      recorder: this.integrationLogs,
      correlationId: correlationId ?? null,
    };
  }

  private get cfg() {
    return this.config.jne;
  }

  /**
   * Grams -> kilograms, the way every other JNE/Paxel call in this codebase
   * already does it: round UP, floor of 1. Couriers bill by started kilogram, so
   * 1,200 g is a 2 kg parcel; sending 1.2 would under-declare it. Matches
   * JneShipmentProvider.createShipment and PaxelProvider exactly, so a quote and
   * the booking that follows describe the same parcel.
   */
  private weightKg(weightGram: number): number {
    return Math.max(1, Math.ceil(weightGram / 1000));
  }

  /**
   * JNE quotation, from JNE's own tariff API (PAXELBOX-61S).
   *
   * This replaced the RajaOngkir-sourced implementation. RajaOngkir is not
   * called here any more, is not a fallback, and neither is a mock: a quote a
   * customer can select and pay must come from the courier that will carry the
   * parcel. Every failure below returns NO quotes rather than a substitute.
   *
   * Weight is sent in KILOGRAMS, which is what JNE documents. The RajaOngkir
   * call this replaced sent grams natively, so the difference is real — hence an
   * explicit, tested conversion rather than an inline expression.
   */
  async getRates(request: ShippingRateRequest): Promise<ShippingQuote[]> {
    // A disabled courier contributes nothing — and no mock stands in for it.
    if (!this.cfg.enabled) return [];
    // The same boundary tracking and cancel enforce: a production courier must
    // never spend the sandbox endpoint, and vice versa.
    assertJneEnvironment(this.cfg);

    if (!this.cfg.username || !this.cfg.apiKey) {
      this.logger.warn({ provider: this.name, outcome: 'skipped', reason: 'missing_jne_credentials' });
      return [];
    }
    // Validated against JNE's ORIGIN master at boot (JneOriginBootValidator), so
    // by the time a request arrives this is a code JNE actually publishes.
    const from = this.cfg.originCode;
    if (!from) {
      this.logger.warn({ provider: this.name, outcome: 'skipped', reason: 'missing_jne_origin_code' });
      return [];
    }

    // District → approved JNE destination code. Null when the district has no
    // reviewed mapping, which is the normal state outside the approved set.
    const thru = await this.destinations.resolve(request.destinationDistrictId);
    if (!thru) {
      this.logger.warn({
        provider: this.name,
        outcome: 'skipped',
        reason: 'no_jne_destination_mapping',
        hasDistrictId: request.destinationDistrictId !== undefined,
        // A region id, not customer data: it names WHICH district to look up in the
        // admin JNE destination diagnostics.
        destinationDistrictId: request.destinationDistrictId ?? null,
      });
      return [];
    }

    const weight = this.weightKg(request.weightGram);
    const form = new URLSearchParams({
      // Credentials travel in the body because JNE's contract puts them there.
      // They are never logged: logBase below carries codes and weight only.
      username: this.cfg.username,
      api_key: this.cfg.apiKey,
      from,
      thru,
      weight: String(weight),
    });

    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${PRICEDEV_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      // No retry in this phase: a tariff lookup that failed once is reported as
      // no quotes, not hammered.
      maxRetry: 0,
      logger: this.logger,
      logBase: { provider: this.name, origin: from, destination: thru, service: 'RATE' },
      integration: this.integration('RATE'),
    });

    return this.mapPricedevResponse(text, from, thru);
  }

  /**
   * JNE tariff response → ShippingQuote. Private, so no raw provider response
   * escapes this class.
   *
   * Anything that cannot be mapped truthfully is DROPPED rather than defaulted.
   * Nothing about JNE's service vocabulary is reinterpreted: `REG15` and `REG19`
   * stay distinct services because they are distinct to JNE, whatever the suffix
   * turns out to mean. JNE Trucking (`isJneTruckingService`) is the one service
   * family the checkout does not offer: those rows are left out of the quotes, so
   * they can be neither listed nor selected. The raw response is not modified.
   */
  private mapPricedevResponse(text: string, from: string, thru: string): ShippingQuote[] {
    let parsed: JnePricedevResponse;
    try {
      parsed = JSON.parse(text) as JnePricedevResponse;
    } catch {
      this.logger.warn({ provider: this.name, outcome: 'unavailable', reason: 'jne_malformed_json', origin: from, destination: thru });
      return [];
    }

    // JNE answers a refusal with HTTP 200 and {"error":"Price Not Found.","status":false}.
    // Logged distinctly so "the courier has no tariff here" can never be read as
    // "the courier quoted nothing", which is what a bare [] would look like.
    if (parsed?.status === false || typeof parsed?.error === 'string') {
      this.logger.warn({
        provider: this.name,
        outcome: 'unavailable',
        reason: 'jne_error_response',
        jneError: parsed?.error ?? '(no message)',
        origin: from,
        destination: thru,
      });
      return [];
    }

    const rows = parsed?.price;
    if (!Array.isArray(rows)) {
      this.logger.warn({ provider: this.name, outcome: 'unavailable', reason: 'jne_malformed_payload', origin: from, destination: thru });
      return [];
    }
    if (rows.length === 0) {
      this.logger.warn({ provider: this.name, outcome: 'unavailable', reason: 'jne_empty_price_list', origin: from, destination: thru });
      return [];
    }

    // Each row is one independent service, so a bad row is dropped on its own and
    // the valid rows survive. Dropped rows are counted by reason and logged once,
    // with service codes only: never the payload, never a price we did not trust.
    const dropped: Record<string, number> = {};
    const droppedServices: string[] = [];
    // Not offered to customers by policy, so not "dropped": counted apart, and only
    // logged when hiding them is what left the destination with no JNE option.
    const hiddenServices: string[] = [];
    const drop = (reason: string, service?: string): null => {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      if (service) droppedServices.push(service);
      return null;
    };

    const quotes = rows
      .map((row): ShippingQuote | null => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) return drop('row_not_object');
        const service = textOf(row.service_code)?.trim();
        if (!service) return drop('missing_service_code');
        if (isJneTruckingService(service)) {
          hiddenServices.push(service);
          return null;
        }
        const cost = parseJnePrice(row.price);
        if (cost === null) return drop('invalid_price', service);
        // Validated only when JNE supplies it; an absent currency is not invented.
        if (row.currency !== undefined && row.currency !== null && textOf(row.currency)?.trim().toUpperCase() !== 'IDR') {
          return drop('non_idr_currency', service);
        }

        return {
          provider: this.name,
          // The code EXACTLY as JNE returned it — REG15 and REG19 stay distinct.
          service,
          // `service_display` is JNE's own label. It is NOT unique across rows
          // (PAXELBOX-61N saw two "REG" rows on one route), so the code is what
          // identifies a service and the display is what a human reads.
          serviceName: textOf(row.service_display)?.trim() || service,
          estimatedDays: this.formatEtd(textOf(row.etd_from), textOf(row.etd_thru)),
          shippingCost: cost,
          providerMeta: {
            service_code: row.service_code ?? null,
            service_display: row.service_display ?? null,
            goods_type: row.goods_type ?? null,
            currency: row.currency ?? null,
            etd_from: row.etd_from ?? null,
            etd_thru: row.etd_thru ?? null,
            times: row.times ?? null,
            origin_name: row.origin_name ?? null,
            destination_name: row.destination_name ?? null,
          },
        };
      })
      .filter((q): q is ShippingQuote => q !== null);

    const anyDropped = Object.keys(dropped).length > 0;
    if (anyDropped || (quotes.length === 0 && hiddenServices.length > 0)) {
      this.logger.warn({
        provider: this.name,
        outcome: quotes.length > 0 ? 'partial' : 'unavailable',
        reason: quotes.length > 0 ? 'jne_rows_dropped' : anyDropped ? 'jne_no_valid_price_rows' : 'jne_only_hidden_services',
        dropped,
        droppedServices,
        ...(hiddenServices.length > 0 ? { hiddenServices } : {}),
        kept: quotes.length,
        origin: from,
        destination: thru,
      });
    }
    return quotes;
  }

  /**
   * ETD bounds → the human string `estimatedDays` carries.
   *
   * Returns 'N/A' when JNE sends null, which PAXELBOX-61O measured on every
   * retail service it observed. 'N/A' is this codebase's existing word for "the
   * courier did not say" — it is not a number, and no number is invented here.
   * The raw bounds survive verbatim in `providerMeta` either way.
   */
  private formatEtd(from: string | null | undefined, thru: string | null | undefined): string {
    const a = from?.trim();
    const b = thru?.trim();
    if (!a && !b) return 'N/A';
    if (a && b) return a === b ? a : `${a}-${b}`;
    return (a || b) as string;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    if (!this.cfg.enabled) {
      return { provider: this.name, trackingNumber, status: 'UNKNOWN', history: [] };
    }
    const form = new URLSearchParams({
      username: this.cfg.username ?? '',
      api_key: this.cfg.apiKey ?? '',
      awb: trackingNumber,
    });
    const { text } = await executeShippingRequest({
      http: this.http,
      url: `${this.cfg.baseUrl}${TRACK_PATH}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: this.cfg.timeoutMs,
      },
      maxRetry: this.cfg.maxRetry,
      logger: this.logger,
      logBase: { provider: this.name, origin: '-', destination: '-', service: 'TRACK' },
      integration: this.integration('TRACK', trackingNumber),
    });
    const status = ((): string => {
      try {
        return (JSON.parse(text) as { cnote?: { pod_status?: string } }).cnote?.pod_status ?? 'IN_TRANSIT';
      } catch {
        return 'IN_TRANSIT';
      }
    })();
    return { provider: this.name, trackingNumber, status, history: [] };
  }
}
