import { Inject, Injectable, Logger } from '@nestjs/common';
import { GEOCODING_CONFIG, GeocodingConfig } from './geocoding.config';
import { redactGeocodingDiagnostic } from './geocoding-diagnostic';
import { GeocodingFailedError, GeocodingUnavailableError } from './geocoding.errors';

/** Swappable transport, so tests never reach Google. Mirrors the shipping stack's shape. */
export type GeocodingHttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; timeoutMs: number },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Minimal projection of Google's response. Nothing else is read or retained. */
interface GoogleGeocodeResponse {
  status?: string;
  error_message?: string;
  results?: Array<{ geometry?: { location?: { lat?: unknown; lng?: unknown } } }>;
}

/**
 * A coordinate we are willing to persist.
 *
 * `(0, 0)` is rejected explicitly. It is a valid point on the globe — in the Gulf
 * of Guinea — but in this system it is the address form's default for "nobody
 * picked a location" (PAXELBOX-61AG.2 found 4 of 8 development addresses at
 * exactly 0,0), so accepting it would let the placeholder back in through the
 * front door.
 *
 * No Indonesia bounding box is applied. Inventing coordinate bounds is exactly
 * the kind of guess this programme refuses: the requirement does not state one,
 * and a wrong box would silently reject legitimate addresses.
 */
export function isPersistableCoordinate(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger('GeocodingService');
  private http: GeocodingHttpClient = defaultGeocodingHttpClient;

  constructor(@Inject(GEOCODING_CONFIG) private readonly config: GeocodingConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Address string -> coordinates.
   *
   * Throws rather than returning a fallback. There is no "close enough" answer
   * here: a wrong coordinate is priced and delivered against, so the only safe
   * failure is to refuse.
   */
  async geocode(address: string): Promise<Coordinates> {
    const query = address.trim();
    if (!query) throw new GeocodingFailedError('Cannot geocode an empty address', 'EMPTY_ADDRESS');
    if (!this.config.apiKey) {
      throw new GeocodingUnavailableError('Geocoding is not configured', 'NO_API_KEY');
    }

    // The key rides in the query string because that is Google's contract. This
    // URL is therefore SECRET-BEARING: it is never logged, never put in an
    // error, and never returned. Only `address.length` is ever reported.
    const url = `${this.config.baseUrl}?address=${encodeURIComponent(query)}&key=${encodeURIComponent(this.config.apiKey)}`;

    const startedAt = Date.now();
    let status: number;
    let text: string;
    try {
      const res = await this.http(url, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: this.config.timeoutMs });
      status = res.status;
      text = await res.text().catch(() => '');
    } catch (err) {
      // Timeout (AbortError) and network failures. No retry: address creation is
      // interactive, and a caller who wants another attempt can simply resubmit.
      const reason = err instanceof Error ? err.name : 'NetworkError';
      this.logger.warn({ event: 'geocode', outcome: 'unavailable', reason: 'network', elapsedMs: Date.now() - startedAt });
      throw new GeocodingUnavailableError(`Geocoding request failed (${reason})`, 'NETWORK');
    }

    if (status < 200 || status >= 300) {
      this.logger.warn({ event: 'geocode', outcome: 'unavailable', httpStatus: status, elapsedMs: Date.now() - startedAt });
      throw new GeocodingUnavailableError(`Geocoding provider returned HTTP ${status}`, 'HTTP_ERROR');
    }

    let parsed: GoogleGeocodeResponse;
    try {
      parsed = JSON.parse(text) as GoogleGeocodeResponse;
    } catch {
      this.logger.warn({ event: 'geocode', outcome: 'unavailable', reason: 'malformed_json', elapsedMs: Date.now() - startedAt });
      throw new GeocodingUnavailableError('Geocoding provider returned a malformed response', 'MALFORMED');
    }

    const googleStatus = parsed.status ?? 'MISSING_STATUS';
    if (googleStatus !== 'OK') {
      // `error_message` is LOGGED (redacted) but never PROPAGATED: the thrown
      // error still carries only the status token. The status alone cannot tell
      // "billing disabled" from "API not enabled on the project" from "key
      // restricted" — all three answer REQUEST_DENIED — so the message is the
      // difference between a one-line diagnosis and a blind hunt
      // (PAXELBOX-61AG.3.8.3). See geocoding-diagnostic.ts for what is scrubbed.
      const googleMessage = redactGeocodingDiagnostic(parsed.error_message, this.config.apiKey);
      this.logger.warn({
        event: 'geocode',
        outcome: 'rejected',
        googleStatus,
        ...(googleMessage ? { googleMessage } : {}),
        elapsedMs: Date.now() - startedAt,
      });
      // ZERO_RESULTS / REQUEST_DENIED / INVALID_REQUEST describe THIS request and
      // will not change on retry; the rest are the provider having a bad moment.
      const permanent = googleStatus === 'ZERO_RESULTS' || googleStatus === 'REQUEST_DENIED' || googleStatus === 'INVALID_REQUEST';
      const Err = permanent ? GeocodingFailedError : GeocodingUnavailableError;
      throw new Err(`Geocoding returned ${googleStatus}`, googleStatus);
    }

    const loc = parsed.results?.[0]?.geometry?.location;
    if (!isPersistableCoordinate(loc?.lat, loc?.lng)) {
      this.logger.warn({ event: 'geocode', outcome: 'rejected', reason: 'unusable_coordinate', elapsedMs: Date.now() - startedAt });
      throw new GeocodingFailedError('Geocoding returned an unusable coordinate', 'UNUSABLE_COORDINATE');
    }

    this.logger.log({ event: 'geocode', outcome: 'ok', addressLength: query.length, elapsedMs: Date.now() - startedAt });
    return { latitude: loc!.lat as number, longitude: loc!.lng as number };
  }
}

/**
 * fetch + AbortController timeout. Written here rather than imported from
 * `shipping/infrastructure/http`: that helper throws shipping-domain errors and
 * logs provider/origin/destination/service, none of which mean anything for an
 * address lookup. Only the eight-line transport shape is shared.
 */
export const defaultGeocodingHttpClient: GeocodingHttpClient = async (url, init) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const controller = new g.AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await g.fetch(url, { method: init.method, headers: init.headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
