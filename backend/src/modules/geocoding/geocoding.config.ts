import { nonNegativeInt as positiveInt } from '../../common/utils/number.util';

export const GEOCODING_CONFIG = 'GEOCODING_CONFIG';

/** Google's documented Geocoding endpoint. Overridable only for tests/proxies. */
const DEFAULT_BASE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export interface GeocodingConfig {
  /**
   * OFF by default, and that is deliberate. Turning geocoding on makes address
   * creation depend on Google: PAXELBOX-61AG.3 forbids persisting a fake
   * coordinate when the lookup fails, so a failure has to surface as an error to
   * the customer. A deployment must therefore opt in once the key is present and
   * the API is enabled on the Google project — until then the existing
   * client-supplied behaviour is preserved unchanged.
   */
  enabled: boolean;
  /** Server-side only. Never sent to a browser, never logged, never in an error. */
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
}

function bool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function loadGeocodingConfig(env: NodeJS.ProcessEnv = process.env): GeocodingConfig {
  return {
    enabled: bool(env.GEOCODING_ENABLED),
    // GOOGLE_MAPS_API_KEY, not NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: anything prefixed
    // NEXT_PUBLIC_ is compiled into the browser bundle by Next, so it must never
    // be the source of a server-side secret.
    apiKey: env.GOOGLE_MAPS_API_KEY,
    baseUrl: (env.GOOGLE_GEOCODING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: positiveInt(env.GEOCODING_TIMEOUT_MS, 5_000),
  };
}

/**
 * Fail fast at boot when geocoding is switched on without a key — the same
 * contract assertShippingConfigured() and assertMidtransConfigured() provide.
 * A disabled feature needs no key.
 */
export function assertGeocodingConfigured(config: GeocodingConfig): void {
  if (!config.enabled) return;
  if (!config.apiKey) {
    throw new Error('GEOCODING_ENABLED=true but GOOGLE_MAPS_API_KEY is not set');
  }
}
