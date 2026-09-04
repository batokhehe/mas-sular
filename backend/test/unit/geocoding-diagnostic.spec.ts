/**
 * PAXELBOX-61AG.3.8.3 — Google `error_message` becomes a redacted LOG field.
 *
 * The property that matters is a split one, and both halves are asserted here:
 *   1. the message reaches the LOG, so REQUEST_DENIED can be diagnosed at all, and
 *   2. it never reaches the thrown error, and therefore never a customer.
 *
 * The API key must survive neither half.
 */

import { Logger } from '@nestjs/common';
import { redactGeocodingDiagnostic } from '../../src/modules/geocoding/geocoding-diagnostic';
import { GeocodingService, type GeocodingHttpClient } from '../../src/modules/geocoding/geocoding.service';

const API_KEY = 'AIzaSyTESTKEYVALUE_not_a_real_key_00000';

describe('redactGeocodingDiagnostic', () => {
  it('passes an ordinary Google message through unchanged', () => {
    const msg = 'This API project is not authorized to use this API.';
    expect(redactGeocodingDiagnostic(msg, API_KEY)).toBe(msg);
  });

  it('REDACTS the configured API key wherever it appears', () => {
    const out = redactGeocodingDiagnostic(`The provided API key ${API_KEY} is invalid.`, API_KEY);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('[REDACTED_KEY]');
  });

  it('redacts a key= parameter even when the value is NOT the configured key', () => {
    // A rotated key, a second project's key, or an echoed query string.
    const out = redactGeocodingDiagnostic('bad request: key=AIzaSySOMETHINGELSE&address=x', API_KEY);
    expect(out).not.toContain('AIzaSySOMETHINGELSE');
    expect(out).toContain('key=[REDACTED]');
  });

  it('drops URLs wholesale — the request URL is secret-bearing by construction', () => {
    const out = redactGeocodingDiagnostic(
      `see https://maps.googleapis.com/maps/api/geocode/json?address=a&key=${API_KEY}`,
      API_KEY,
    );
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain('googleapis.com');
    expect(out).toContain('[url]');
  });

  it('truncates long text to a log-sized field', () => {
    const out = redactGeocodingDiagnostic('x'.repeat(500), API_KEY)!;
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns undefined when there is nothing useful to log', () => {
    expect(redactGeocodingDiagnostic(undefined, API_KEY)).toBeUndefined();
    expect(redactGeocodingDiagnostic('', API_KEY)).toBeUndefined();
    expect(redactGeocodingDiagnostic('   ', API_KEY)).toBeUndefined();
    expect(redactGeocodingDiagnostic(42 as unknown as string, API_KEY)).toBeUndefined();
  });

  it('still works when no API key is configured', () => {
    expect(redactGeocodingDiagnostic('Billing must be enabled.', undefined)).toBe('Billing must be enabled.');
    // An empty key must not turn every character into a redaction marker.
    expect(redactGeocodingDiagnostic('Billing must be enabled.', '')).toBe('Billing must be enabled.');
  });
});

describe('GeocodingService logs the diagnostic but never propagates it', () => {
  function build(body: string) {
    const http: GeocodingHttpClient = async () => ({ status: 200, text: async () => body });
    const service = new GeocodingService({
      enabled: true, apiKey: API_KEY, baseUrl: 'https://maps.test/geocode/json', timeoutMs: 500,
    } as never);
    (service as unknown as { http: GeocodingHttpClient }).http = http;
    return service;
  }

  const denied = (errorMessage?: string) =>
    JSON.stringify({ status: 'REQUEST_DENIED', ...(errorMessage ? { error_message: errorMessage } : {}) });

  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it('puts the message in the log line', async () => {
    const service = build(denied('You must enable Billing on the Google Cloud Project.'));
    await expect(service.geocode('Jl. Braga')).rejects.toThrow();
    const logged = warn.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(logged.googleStatus).toBe('REQUEST_DENIED');
    expect(logged.googleMessage).toBe('You must enable Billing on the Google Cloud Project.');
  });

  it('the THROWN error still carries only the status token', async () => {
    const service = build(denied('You must enable Billing on the Google Cloud Project.'));
    let message = '';
    try { await service.geocode('Jl. Braga'); } catch (e) { message = (e as Error).message; }
    expect(message).toBe('Geocoding returned REQUEST_DENIED');
    expect(message).not.toContain('Billing');
  });

  it('never logs the API key, even when Google echoes it', async () => {
    const service = build(denied(`The provided API key ${API_KEY} is invalid.`));
    await expect(service.geocode('Jl. Braga')).rejects.toThrow();
    const logged = warn.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(JSON.stringify(logged)).not.toContain(API_KEY);
    expect(logged.googleMessage).toContain('[REDACTED_KEY]');
  });

  it('omits the field entirely when Google sends no message', async () => {
    const service = build(denied());
    await expect(service.geocode('Jl. Braga')).rejects.toThrow();
    const logged = warn.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('googleMessage' in logged).toBe(false);
    expect(logged.googleStatus).toBe('REQUEST_DENIED');
  });
});
