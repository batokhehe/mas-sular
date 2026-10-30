/**
 * Paxel quotes in the integration log (Log Integrasi).
 *
 * Every checkout asks Paxel for three quotes (INSTANT is hidden), and until now none of them reached
 * IntegrationApiLog - so a quote that worked and a quote that failed looked the same
 * in the admin (nothing), and a PAXEL_REGULAR 400 left no body anywhere to diagnose.
 *
 * They are now recorded as operation RATE (the word the admin filter already offers),
 * but a quote body carries the customer's street address, postal code and coordinates,
 * so it is never stored: the sanitized request is a city/district summary, and both
 * raw body columns stay null.
 */
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { IntegrationLogService } from '../../src/infrastructure/integration-log/integration-log.service';
import { loadIntegrationLogConfig } from '../../src/infrastructure/integration-log/integration-log.config';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';
import { ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';

const API_KEY = 'pk_live_DO_NOT_LEAK_1234567890';
const API_SECRET = 'sk_live_DO_NOT_LEAK_abcdefghij';

// Customer data that must never reach a persisted RATE row.
const STREET = 'Jl. Pelanggan Rahasia No. 7';
const POSTAL = '40288';
const VILLAGE = 'Bojongsari';
const LAT = -6.987654;
const LNG = 107.654321;

function config(): ShippingConfig {
  return {
    allowMockRates: false,
    paxel: {
      enabled: true,
      baseUrl: 'https://paxel.test/v1',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      originPhone: '081212121212',
      originNote: 'gerbang samping',
      timeoutMs: 500,
      maxRetry: 0,
      defaultDimension: '30x35x20',
      needInsurance: false,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  } as ShippingConfig;
}

const request: ShippingRateRequest = {
  originPostalCode: '40111',
  destinationPostalCode: POSTAL,
  weightGram: 1500,
  originAddress: 'Jl. Outlet No.1',
  originProvince: 'Jawa Barat',
  originCity: 'Kota Bandung',
  originDistrict: 'Coblong',
  destinationAddress: STREET,
  destinationProvince: 'Jawa Barat',
  destinationCity: 'Kabupaten Bandung',
  destinationDistrict: 'Bojongsoang',
  destinationVillage: VILLAGE,
  destinationLatitude: LAT,
  destinationLongitude: LNG,
} as ShippingRateRequest;

const res = (status: number, body = ''): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

const OK_BODY = JSON.stringify({ code: 200, data: { fixed_price: 18000, service_type: 'SAMEDAY' } });
// A shape-only stand-in for a provider refusal: the real PAXEL_REGULAR body is not known yet.
const REFUSAL_BODY = JSON.stringify({ code: 400, message: 'Service type is not available', errors: { service_type: ['invalid'] } });

function recorder() {
  const entries: IntegrationLogEntry[] = [];
  return { entries, record: (e: IntegrationLogEntry) => entries.push(e) };
}

function build(http: (url: string, init: ShippingHttpRequest) => Promise<ShippingHttpResponse>) {
  const rec = recorder();
  const provider = new PaxelProvider(config(), rec as never);
  const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
  (provider as unknown as { http: unknown }).http = async (url: string, init: ShippingHttpRequest) => {
    calls.push({ url, init });
    return http(url, init);
  };
  return { provider, rec, calls };
}

/** SAMEDAY/NEXTDAY answer 200, REGULAR is refused with a 400 - as observed in production. */
const productionLike = async (_url: string, init: ShippingHttpRequest) =>
  JSON.parse(init.body as string).service_type === 'REGULAR' ? res(400, REFUSAL_BODY) : res(200, OK_BODY);

/** Run entries through the real IntegrationLogService mapping and return the rows it would insert. */
async function persisted(entries: IntegrationLogEntry[]): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => rows.push(data));
  const service = new IntegrationLogService({ integrationApiLog: { create } } as never, loadIntegrationLogConfig({} as NodeJS.ProcessEnv));
  entries.forEach((e) => service.record(e));
  await new Promise((resolve) => setImmediate(resolve));
  return rows;
}

const FORBIDDEN = [API_KEY, API_SECRET, STREET, POSTAL, VILLAGE, String(LAT), String(LNG), 'X-Paxel-API-Key'];

describe('Paxel quotes are recorded as RATE', () => {
  it('one entry per service, successful and refused alike, under the admin filter word RATE', async () => {
    const { provider, rec } = build(productionLike);
    const quotes = await provider.getRates(request);

    expect(quotes.map((q) => q.service).sort()).toEqual(['PAXEL_NEXTDAY', 'PAXEL_SAMEDAY']);
    expect(rec.entries).toHaveLength(3);
    for (const entry of rec.entries) {
      // 'RATE' is the operation admin/lib/system/integration-log-view.ts lists for PAXEL.
      expect(entry).toMatchObject({ provider: IntegrationProvider.PAXEL, operation: 'RATE', direction: IntegrationDirection.OUTBOUND, method: 'POST' });
    }
    const byService = Object.fromEntries(
      rec.entries.map((e) => [(e.requestPayload as { service_type: string }).service_type, e]),
    );
    for (const service of ['SAMEDAY', 'NEXTDAY']) {
      expect(byService[service]).toMatchObject({ applicationOutcome: IntegrationOutcome.OK, httpStatus: 200 });
    }
    expect(byService.REGULAR).toMatchObject({
      applicationOutcome: IntegrationOutcome.HTTP_ERROR,
      httpStatus: 400,
      errorClass: 'permanent_4xx',
    });
    expect(byService.REGULAR.errorMessage).toContain('Service type is not available');
  });

  it('no raw body is handed to the recorder: only the city/district summary', async () => {
    const { provider, rec } = build(productionLike);
    await provider.getRates(request);

    for (const entry of rec.entries) {
      expect(entry.requestBody).toBeUndefined();
      expect(entry.responseBody).toBeUndefined();
      expect(entry.requestPayload).toEqual({
        service_type: expect.any(String),
        weight: 1500,
        dimension: '30x35x20',
        origin: { province: 'Jawa Barat', city: 'Kota Bandung', district: 'Coblong' },
        destination: { province: 'Jawa Barat', city: 'Kabupaten Bandung', district: 'Bojongsoang' },
      });
    }
    const handedOver = JSON.stringify(rec.entries);
    for (const secret of FORBIDDEN) expect(handedOver).not.toContain(secret);
  });

  it('the persisted rows keep status, outcome and a sanitized response, but no raw body', async () => {
    const { provider, rec } = build(productionLike);
    await provider.getRates(request);
    const rows = await persisted(rec.entries);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.rawRequestBody).toBeNull();
      expect(row.rawResponseBody).toBeNull();
      expect(row.sanitizedRequest).toMatchObject({ destination: { district: 'Bojongsoang' } });
      // The admin drawer shows this column verbatim when the raw body is null, so its
      // exact key set is the contract: no address, village, postal code or coordinate.
      expect(row.sanitizedRequest).toEqual({
        service_type: expect.any(String),
        weight: 1500,
        dimension: '30x35x20',
        origin: { province: 'Jawa Barat', city: 'Kota Bandung', district: 'Coblong' },
        destination: { province: 'Jawa Barat', city: 'Kabupaten Bandung', district: 'Bojongsoang' },
      });
      expect(row.endpoint).toMatch(/^https:\/\/paxel\.test\/v1\/rates\/(city|instant)$/);
      expect(typeof row.durationMs).toBe('number');
    }
    const refused = rows.find((r) => r.httpStatus === 400) as Record<string, unknown>;
    expect(refused).toMatchObject({ operation: 'RATE', applicationOutcome: IntegrationOutcome.HTTP_ERROR, errorClass: 'permanent_4xx' });
    expect(refused.sanitizedResponse).toMatchObject({ code: 400, message: 'Service type is not available' });
    expect(refused.errorMessage).toContain('Service type is not available');

    const stored = JSON.stringify(rows);
    for (const secret of FORBIDDEN) expect(stored).not.toContain(secret);
  });

  it('a response that echoes the address is redacted before it is stored', async () => {
    const echo = JSON.stringify({ code: 200, data: { fixed_price: 18000, destination: { address: STREET, zip_code: POSTAL } } });
    const { provider, rec } = build(async () => res(200, echo));
    await provider.getRates(request);
    const rows = await persisted(rec.entries);

    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(STREET);
    expect(rows[0].sanitizedResponse).toMatchObject({ data: { fixed_price: 18000, destination: { address: '[REDACTED_PII]' } } });
  });

  it('a network failure is recorded too, still without a raw body', async () => {
    const { provider, rec } = build(async () => {
      throw new Error('socket hang up');
    });
    await provider.getRates(request);

    expect(rec.entries).toHaveLength(3);
    for (const entry of rec.entries) {
      expect(entry).toMatchObject({ operation: 'RATE', applicationOutcome: IntegrationOutcome.NETWORK_ERROR });
      expect(entry.requestBody).toBeUndefined();
    }
    const rows = await persisted(rec.entries);
    for (const row of rows) expect(row.rawRequestBody).toBeNull();
  });

  it('the request Paxel receives is unchanged: the full body still goes out', async () => {
    const { provider, calls } = build(productionLike);
    await provider.getRates(request);

    const sent = calls.map((c) => JSON.parse(c.init.body as string));
    expect(sent.find((b) => b.service_type === 'SAMEDAY').destination).toMatchObject({ address: STREET, zip_code: POSTAL, latitude: LAT, longitude: LNG });
    expect(calls.every((c) => c.init.headers['X-Paxel-API-Key'] === API_KEY)).toBe(true);
  });
});

describe('a provider error in free text is never stored as-is', () => {
  // Synthetic only. The address has NO digit, so only the "was it sent?" check can catch it.
  const PLAIN_STREET = 'Gland Sintetis Park';
  const plainRequest = { ...request, destinationAddress: PLAIN_STREET } as ShippingRateRequest;

  const leakyError = JSON.stringify({
    code: 400,
    message: `Alamat ${PLAIN_STREET} di luar jangkauan`,
    detail: `Kode pos ${POSTAL} kelurahan ${VILLAGE} (${LAT},${LNG}) tidak dilayani`,
    errors: { service_type: ['Service type is not available'], 'destination.address': [PLAIN_STREET] },
    echo: { latitude: LAT, longitude: LNG, zip: POSTAL, kelurahan: VILLAGE, key: API_KEY, auth: `Bearer ${API_SECRET}` },
  });

  async function rowsFor(body: string, req: ShippingRateRequest = plainRequest) {
    const { provider, rec } = build(async () => res(400, body));
    await provider.getRates(req);
    return { entries: rec.entries, rows: await persisted(rec.entries) };
  }

  it('street, postal code, subdistrict, coordinates and credentials never reach a stored field', async () => {
    const { rows } = await rowsFor(leakyError);
    const stored = JSON.stringify(rows);
    for (const secret of [PLAIN_STREET, POSTAL, VILLAGE, String(LAT), String(LNG), API_KEY, API_SECRET, 'Bearer']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('the diagnosis survives: status, class, which field was refused, and the safe message', async () => {
    const { rows } = await rowsFor(leakyError);
    const row = rows[0];
    expect(row).toMatchObject({ operation: 'RATE', httpStatus: 400, applicationOutcome: IntegrationOutcome.HTTP_ERROR, errorClass: 'permanent_4xx' });
    expect(row.sanitizedResponse).toMatchObject({
      code: 400,
      message: '[TEXT]',
      detail: '[TEXT]',
      errors: { service_type: ['Service type is not available'] },
      echo: { latitude: '[NUMBER]', longitude: '[NUMBER]', zip: '[TEXT]', kelurahan: '[TEXT]' },
    });
    // A key that is not identifier-shaped is dropped rather than trusted.
    expect(row.sanitizedResponse).not.toHaveProperty(['errors', 'destination.address']);
    expect(row.errorMessage).toContain('Service type is not available');
    expect(row.errorMessage).not.toContain(PLAIN_STREET);
  });

  it('a short error code is kept; a token-shaped value is not, whatever its key', async () => {
    const { rows } = await rowsFor(JSON.stringify({ code: 400, error_code: 'INVALID_SERVICE_TYPE', note_ref: 'abcDEFghiJKLmnoPQRstuVWXyz_token' }));
    expect(rows[0].sanitizedResponse).toMatchObject({ code: 400, error_code: 'INVALID_SERVICE_TYPE', note_ref: '[TEXT]' });
  });

  it('a non-JSON error page is stored as its size only', async () => {
    const { rows } = await rowsFor(`<html><body>Bad request for ${PLAIN_STREET}, ${POSTAL}</body></html>`);
    expect(rows[0].sanitizedResponse).toEqual({ nonJson: true, length: expect.any(Number) });
    expect(JSON.stringify(rows)).not.toContain(PLAIN_STREET);
  });

  it('a successful quote keeps its price but not an echoed location', async () => {
    const ok = JSON.stringify({ code: 200, data: { fixed_price: 18000, service_type: 'SAMEDAY', destination: { lat: LAT, note: PLAIN_STREET } } });
    const { provider, rec } = build(async () => res(200, ok));
    await provider.getRates(plainRequest);
    const rows = await persisted(rec.entries);
    expect(rows[0].sanitizedResponse).toMatchObject({ code: 200, data: { fixed_price: 18000, service_type: 'SAMEDAY', destination: { lat: '[NUMBER]' } } });
    expect(rows[0].errorMessage).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(PLAIN_STREET);
  });
});

describe('a successful quote keeps the business values a quote is debugged from', () => {
  // The shape of a real production RATE response (keys and nesting as stored for a
  // SAMEDAY quote); every value here is synthetic.
  const serviceWindow = (service: string, overrides: Record<string, unknown> = {}) => ({
    service,
    available_day: { day_details: 'Senin - Jumat 08:00', unavailable_days: 'Minggu', unavailable_day_details: '' },
    time_pickup_start: '08:00',
    time_pickup_end: '14:00:00',
    time_delivery_start: '2026-10-29 10:00:00',
    time_delivery_end: '2026-10-29T18:30:00+07:00',
    ...overrides,
  });
  const quote = (data: Record<string, unknown>) => JSON.stringify({ status_code: 200, message: 'OK', data });
  const PRICES = { fixed_price: 101000, small_price: 18000, medium_price: 26000, large_price: 39000, custom_price: '101000', response_code: 200 };

  async function stored(body: string) {
    const { provider, rec } = build(async () => res(200, body));
    await provider.getRates(request);
    return (await persisted(rec.entries))[0];
  }

  it('prices, the response code and well-formed service times are stored as received', async () => {
    const row = await stored(quote({ ...PRICES, city_origin: 'KOTA BANDUNG', fixed_price_type: 'dimension', time_detail: [serviceWindow('same_day')] }));
    expect(row.sanitizedResponse).toEqual({
      status_code: 200,
      message: 'OK',
      data: {
        ...PRICES,
        city_origin: 'KOTA BANDUNG',
        fixed_price_type: 'dimension',
        time_detail: [
          {
            service: 'same_day',
            // Free text with a digit is still hidden: only the strict time fields are opened.
            available_day: { day_details: '[TEXT]', unavailable_days: 'Minggu', unavailable_day_details: '' },
            time_pickup_start: '08:00',
            time_pickup_end: '14:00:00',
            time_delivery_start: '2026-10-29 10:00:00',
            time_delivery_end: '2026-10-29T18:30:00+07:00',
          },
        ],
      },
    });
  });

  it('a time field that is not exactly a time, and a price field that is not a price, stay hidden', async () => {
    const row = await stored(
      quote({
        fixed_price: `Bearer ${API_SECRET}`,
        small_price: API_KEY,
        medium_price: POSTAL + '0000',
        large_price: { lat: LAT },
        time_detail: [
          serviceWindow('same_day', {
            time_pickup_start: `08:00 ${STREET}`,
            time_pickup_end: POSTAL,
            time_delivery_start: `${LAT},${LNG}`,
            time_delivery_end: '25:00',
            time_note: '08:00 Bojongsari',
          }),
        ],
      }),
    );
    const data = (row.sanitizedResponse as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ fixed_price: '[TEXT]', small_price: '[TEXT]', medium_price: '[TEXT]', large_price: { lat: '[NUMBER]' } });
    expect((data.time_detail as Array<Record<string, unknown>>)[0]).toMatchObject({
      time_pickup_start: '[TEXT]',
      time_pickup_end: '[TEXT]',
      time_delivery_start: '[TEXT]',
      time_delivery_end: '[TEXT]',
      time_note: '[TEXT]',
    });
    const all = JSON.stringify(row);
    for (const secret of [...FORBIDDEN, 'Bearer', 'Pelanggan']) expect(all).not.toContain(secret);
  });

  it('the raw columns stay empty and the request summary carries no customer data', async () => {
    const row = await stored(quote(PRICES));
    expect(row.rawRequestBody).toBeNull();
    expect(row.rawResponseBody).toBeNull();
    expect(JSON.stringify(row.sanitizedRequest)).not.toMatch(new RegExp([STREET, POSTAL, VILLAGE, String(LAT), String(LNG), API_KEY].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
  });
});

describe('PAXEL_REGULAR request and refusal, as verified so far', () => {
  it('posts service_type REGULAR to <base>/rates/city with the same body as the other city services', async () => {
    const { provider, calls } = build(productionLike);
    await provider.getRates(request);

    const regular = calls.find((c) => JSON.parse(c.init.body as string).service_type === 'REGULAR');
    const sameday = calls.find((c) => JSON.parse(c.init.body as string).service_type === 'SAMEDAY');
    expect(regular?.url).toBe('https://paxel.test/v1/rates/city');
    const { service_type: _r, ...regularRest } = JSON.parse(regular?.init.body as string);
    const { service_type: _s, ...samedayRest } = JSON.parse(sameday?.init.body as string);
    expect(regularRest).toEqual(samedayRest);
  });

  it('a 400 is permanent: one attempt, the service drops out, the others are still quoted', async () => {
    const { provider, calls, rec } = build(productionLike);
    const quotes = await provider.getRates(request);

    expect(calls.filter((c) => JSON.parse(c.init.body as string).service_type === 'REGULAR')).toHaveLength(1);
    expect(quotes.some((q) => q.service === 'PAXEL_REGULAR')).toBe(false);
    expect(quotes).toHaveLength(2);
    // The refusal is no longer lost: its sanitized body is in the RATE record.
    expect(rec.entries.find((e) => e.httpStatus === 400)?.responsePayload).toMatchObject({ code: 400 });
  });
});
