/**
 * PAXELBOX-61AG.3 — Google Geocoding client.
 *
 * Every test mocks the transport. No test reaches Google, and no test may: the
 * one controlled real call this phase makes lives in its own smoke script.
 *
 * The recurring theme below is that geocoding NEVER returns a fallback. A wrong
 * coordinate is priced and delivered against, so the only safe failure is to
 * refuse — which is why every error path asserts a throw rather than a default.
 */

import {
  GeocodingService,
  isPersistableCoordinate,
  type GeocodingHttpClient,
} from '../../src/modules/geocoding/geocoding.service';
import { GeocodingFailedError, GeocodingUnavailableError } from '../../src/modules/geocoding/geocoding.errors';
import { loadGeocodingConfig, assertGeocodingConfigured } from '../../src/modules/geocoding/geocoding.config';

const API_KEY = 'test-maps-key-value';
const ok = (lat: number, lng: number) =>
  JSON.stringify({ status: 'OK', results: [{ geometry: { location: { lat, lng } } }] });

function build(body: string | Error, status = 200, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const http: GeocodingHttpClient = async (url) => {
    calls.push(url);
    if (body instanceof Error) throw body;
    return { status, text: async () => body };
  };
  const config = { enabled: true, apiKey: API_KEY, baseUrl: 'https://maps.test/geocode/json', timeoutMs: 500, ...over };
  const service = new GeocodingService(config as never);
  (service as unknown as { http: GeocodingHttpClient }).http = http;
  return { service, calls, config };
}

describe('GeocodingService.geocode', () => {
  it('returns the coordinates from a Google OK response', async () => {
    const { service } = build(ok(-6.9175, 107.6191));
    await expect(service.geocode('Jl. Braga, Bandung')).resolves.toEqual({ latitude: -6.9175, longitude: 107.6191 });
  });

  it('sends the address and key as query parameters', async () => {
    const { service, calls } = build(ok(-6.9, 107.6));
    await service.geocode('Jl. Braga, Bandung');
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://maps.test/geocode/json');
    expect(url.searchParams.get('address')).toBe('Jl. Braga, Bandung');
    expect(url.searchParams.get('key')).toBe(API_KEY);
  });

  describe('Google status handling', () => {
    it.each([
      ['ZERO_RESULTS', GeocodingFailedError],
      ['REQUEST_DENIED', GeocodingFailedError],
      ['INVALID_REQUEST', GeocodingFailedError],
    ])('%s is a permanent failure — retrying cannot help', async (status, Kind) => {
      const { service } = build(JSON.stringify({ status }));
      await expect(service.geocode('nowhere')).rejects.toBeInstanceOf(Kind);
      await expect(service.geocode('nowhere')).rejects.toThrow(new RegExp(status));
    });

    it.each([['OVER_QUERY_LIMIT'], ['UNKNOWN_ERROR'], ['MISSING_STATUS']])(
      '%s is transient — the same address may work later',
      async (status) => {
        const body = status === 'MISSING_STATUS' ? JSON.stringify({ results: [] }) : JSON.stringify({ status });
        const { service } = build(body);
        await expect(service.geocode('somewhere')).rejects.toBeInstanceOf(GeocodingUnavailableError);
      },
    );

    it('never propagates Google error_message, which can echo the request', async () => {
      const { service } = build(JSON.stringify({ status: 'REQUEST_DENIED', error_message: `key=${API_KEY} is invalid` }));
      let message = '';
      try {
        await service.geocode('anywhere');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe('Geocoding returned REQUEST_DENIED');
      expect(message).not.toContain(API_KEY);
    });
  });

  describe('transport failures', () => {
    it('malformed JSON is transient, not a coordinate', async () => {
      const { service } = build('<html>502 Bad Gateway</html>');
      await expect(service.geocode('x')).rejects.toBeInstanceOf(GeocodingUnavailableError);
    });

    it('a non-2xx status is transient', async () => {
      const { service } = build('{}', 503);
      await expect(service.geocode('x')).rejects.toBeInstanceOf(GeocodingUnavailableError);
    });

    it('a timeout is transient', async () => {
      const { service } = build(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await expect(service.geocode('x')).rejects.toBeInstanceOf(GeocodingUnavailableError);
    });

    it('makes exactly one request — no retry storm on an interactive flow', async () => {
      const { service, calls } = build(JSON.stringify({ status: 'UNKNOWN_ERROR' }));
      await expect(service.geocode('x')).rejects.toThrow();
      expect(calls).toHaveLength(1);
    });
  });

  describe('coordinates that must never be persisted', () => {
    it.each([
      ['0,0 — the address form default', 0, 0],
      ['latitude out of range', 91, 107],
      ['longitude out of range', -6, 181],
      ['NaN', Number.NaN, 107],
      ['Infinity', Number.POSITIVE_INFINITY, 107],
      ['a string masquerading as a number', '-6.9' as unknown as number, 107],
    ])('rejects %s', async (_label, lat, lng) => {
      const { service } = build(JSON.stringify({ status: 'OK', results: [{ geometry: { location: { lat, lng } } }] }));
      await expect(service.geocode('x')).rejects.toBeInstanceOf(GeocodingFailedError);
    });

    it('rejects an OK response with no results at all', async () => {
      const { service } = build(JSON.stringify({ status: 'OK', results: [] }));
      await expect(service.geocode('x')).rejects.toBeInstanceOf(GeocodingFailedError);
    });
  });

  describe('guard rails', () => {
    it('refuses an empty address rather than asking Google about nothing', async () => {
      const { service, calls } = build(ok(-6, 107));
      await expect(service.geocode('   ')).rejects.toBeInstanceOf(GeocodingFailedError);
      expect(calls).toHaveLength(0);
    });

    it('refuses when no API key is configured', async () => {
      const { service, calls } = build(ok(-6, 107), 200, { apiKey: undefined });
      await expect(service.geocode('Jl. Braga')).rejects.toBeInstanceOf(GeocodingUnavailableError);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('isPersistableCoordinate', () => {
  it('accepts a real Indonesian coordinate', () => {
    expect(isPersistableCoordinate(-6.9175, 107.6191)).toBe(true);
  });

  it('accepts valid coordinates elsewhere — no invented country bounding box', () => {
    // Deliberately NOT restricted to Indonesia: the requirement states no bounds,
    // and a guessed box would silently reject legitimate addresses.
    expect(isPersistableCoordinate(51.5074, -0.1278)).toBe(true);
  });

  it.each([
    [0, 0],
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.POSITIVE_INFINITY, 1],
    [-91, 0.1],
    [91, 0.1],
    [0.1, -181],
    [0.1, 181],
  ])('rejects (%s, %s)', (lat, lng) => {
    expect(isPersistableCoordinate(lat, lng)).toBe(false);
  });

  it('rejects non-numbers, including numeric strings', () => {
    expect(isPersistableCoordinate('-6.9', '107.6')).toBe(false);
    expect(isPersistableCoordinate(undefined, undefined)).toBe(false);
    expect(isPersistableCoordinate(null, null)).toBe(false);
  });

  it('accepts a coordinate on exactly one axis at zero', () => {
    // Only the (0,0) pair is the placeholder; a real equator/meridian point is not.
    expect(isPersistableCoordinate(0, 107.6)).toBe(true);
    expect(isPersistableCoordinate(-6.9, 0)).toBe(true);
  });
});

describe('loadGeocodingConfig', () => {
  it('is OFF unless explicitly enabled', () => {
    expect(loadGeocodingConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(loadGeocodingConfig({ GEOCODING_ENABLED: 'false' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(loadGeocodingConfig({ GEOCODING_ENABLED: 'true' } as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  it('reads the SERVER-side key, never a NEXT_PUBLIC_ one', () => {
    const c = loadGeocodingConfig({
      GOOGLE_MAPS_API_KEY: 'server-key',
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: 'browser-key',
    } as NodeJS.ProcessEnv);
    expect(c.apiKey).toBe('server-key');
    expect(JSON.stringify(c)).not.toContain('browser-key');
  });

  it('defaults to the documented Google endpoint', () => {
    expect(loadGeocodingConfig({} as NodeJS.ProcessEnv).baseUrl).toBe('https://maps.googleapis.com/maps/api/geocode/json');
  });

  it('has a finite default timeout', () => {
    expect(loadGeocodingConfig({} as NodeJS.ProcessEnv).timeoutMs).toBe(5000);
    expect(loadGeocodingConfig({ GEOCODING_TIMEOUT_MS: '1500' } as NodeJS.ProcessEnv).timeoutMs).toBe(1500);
  });
});

describe('assertGeocodingConfigured', () => {
  it('requires a key once enabled', () => {
    expect(() => assertGeocodingConfigured({ enabled: true, baseUrl: 'x', timeoutMs: 1 })).toThrow(/GOOGLE_MAPS_API_KEY/);
  });

  it('needs nothing while disabled', () => {
    expect(() => assertGeocodingConfigured({ enabled: false, baseUrl: 'x', timeoutMs: 1 })).not.toThrow();
  });

  it('never puts the key in the error message', () => {
    let message = '';
    try {
      assertGeocodingConfigured({ enabled: true, apiKey: undefined, baseUrl: 'x', timeoutMs: 1 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(API_KEY);
  });
});
