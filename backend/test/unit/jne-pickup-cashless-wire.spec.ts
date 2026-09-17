import {
  buildJnePickupCashlessFields,
  JNE_PICKUP_CASHLESS_FIELDS,
  JnePickupCashlessSource,
  parseJnePickupCashlessResponse,
  serializeJnePickupCashless,
} from '../../src/modules/shipment/infrastructure/providers/jne-pickup-cashless';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { ShippingConfig, JnePickupConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpClient, ShippingHttpRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * DIAGNOSTIC (test-only): the FINAL /pickupcashless wire body, not the intermediate
 * field object. Built through the real builder + serializer and captured at the
 * transport boundary (a mocked http client - no network), then parsed back.
 *
 * Operational values mirror staging (BRANCH, CUST_ID, codes, enums); every name,
 * phone and address is a placeholder. Nothing here prints a value: failures name
 * the KEY only, so no credential or PII can reach test output.
 */

const PICKUP: Required<JnePickupConfig> = {
  pickupName: 'Placeholder Outlet',
  pickupPic: 'Placeholder Pic',
  pickupPicPhone: '080000000001',
  pickupAddress: 'Jl. Placeholder No. 1',
  pickupDistrict: 'Buahbatu',
  pickupCity: 'Bandung',
  pickupService: 'Domestic',
  pickupVehicle: 'Mobil',
  branch: 'BDO000',
  custId: 'MASSULAR',
  merchantId: 'MASSULAR',
  shipperName: 'Placeholder Shipper',
  shipperAddr1: 'Jl. Placeholder No. 1',
  shipperAddr2: 'Kel. Placeholder',
  shipperCity: 'Bandung',
  shipperZip: '40286',
  shipperRegion: 'Jawa Barat',
  shipperContact: 'Placeholder Contact',
  shipperPhone: '080000000002',
  type: 'PICKUP',
};

const SOURCE: JnePickupCashlessSource = {
  orderNumber: 'BMS-20260916-MY5NMV4X',
  service: 'JTR<130',
  goodsAmount: 45_000,
  destinationCode: 'BDO10060',
  pickupAtIso: '2026-09-17T10:00:00.000Z', // 17-09-2026 17:00 WIB
  receiver: {
    name: 'Placeholder Receiver',
    phone: '080000000003',
    addressDetail: 'Jl. Placeholder Tujuan No. 2',
    village: 'Placeholder',
    district: 'Placeholder',
    city: 'Kota Bandung',
    postalCode: '40112',
    province: 'Jawa Barat',
  },
  items: [{ name: 'Keju Nyakrek', quantity: 1, weightGram: 250 }],
};

const CREDENTIALS = { username: 'placeholder-user', apiKey: 'placeholder-key' };

/** The fields the JNE documentation marks mandatory and the user asked to verify. */
const DOCUMENTED_CHECK = [
  'ORDER_ID', 'SPECIAL_INS', 'PICKUP_DATE', 'PICKUP_TIME', 'BRANCH', 'CUST_ID',
  'MERCHANT_ID', 'ORIGIN_CODE', 'DESTINATION_CODE', 'SERVICE_CODE', 'TYPE',
] as const;

interface WireReport {
  keys: string[];
  missing: string[];
  empty: string[];
  whitespaceOnly: string[];
  duplicates: string[];
  encodingMismatches: string[];
  unexpectedKeys: string[];
  nonAsciiOrControlKeys: string[];
}

/** Parses a serialized form body back and reports problems by KEY NAME only. */
function diagnoseWireBody(body: string, mandatory: readonly string[], sentFields: Record<string, string>): WireReport {
  const parsed = new URLSearchParams(body);
  const rawKeys = body.split('&').map((pair) => decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' ')));
  const expected = ['username', 'api_key', ...JNE_PICKUP_CASHLESS_FIELDS];
  const keys = [...new Set(rawKeys)];
  return {
    keys,
    missing: mandatory.filter((k) => !parsed.has(k)),
    empty: mandatory.filter((k) => parsed.has(k) && parsed.get(k) === ''),
    whitespaceOnly: mandatory.filter((k) => { const v = parsed.get(k); return v !== null && v !== '' && v.trim() === ''; }),
    duplicates: keys.filter((k) => parsed.getAll(k).length > 1),
    encodingMismatches: Object.keys(sentFields).filter((k) => parsed.get(k) !== sentFields[k]),
    unexpectedKeys: keys.filter((k) => !expected.includes(k)),
    nonAsciiOrControlKeys: rawKeys.filter((k) => !/^[A-Za-z0-9_]+$/.test(k)),
  };
}

function shippingConfig(): ShippingConfig {
  return {
    allowMockRates: false,
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid', timeoutMs: 1000, maxRetry: 0 },
    paxel: { enabled: false, baseUrl: 'https://paxel.invalid', timeoutMs: 1000, maxRetry: 0 },
    jne: {
      enabled: true,
      environment: 'sandbox',
      baseUrl: 'https://jne.invalid:10202',
      username: CREDENTIALS.username,
      apiKey: CREDENTIALS.apiKey,
      originCode: 'BDO10000',
      timeoutMs: 1000,
      maxRetry: 0,
      pickup: PICKUP,
    },
  } as unknown as ShippingConfig;
}

describe('JNE /pickupcashless FINAL wire body (diagnostic)', () => {
  const fields = buildJnePickupCashlessFields(SOURCE, PICKUP, 'BDO10000');
  const body = serializeJnePickupCashless(CREDENTIALS, fields);
  const allMandatory = ['username', 'api_key', ...JNE_PICKUP_CASHLESS_FIELDS];

  it('has 42 unique keys, in documented order, with no renaming, casing change or duplicate', () => {
    const report = diagnoseWireBody(body, allMandatory, { ...fields, username: CREDENTIALS.username, api_key: CREDENTIALS.apiKey });
    expect(report.keys).toEqual(['username', 'api_key', ...JNE_PICKUP_CASHLESS_FIELDS]);
    expect(report.keys).toHaveLength(42);
    expect(report.duplicates).toEqual([]);
    expect(report.unexpectedKeys).toEqual([]);
    expect(report.nonAsciiOrControlKeys).toEqual([]);
  });

  it('every sent field is present, non-empty and not whitespace-only ON THE WIRE', () => {
    const report = diagnoseWireBody(body, allMandatory, fields);
    expect(report.missing).toEqual([]);
    expect(report.empty).toEqual([]);
    expect(report.whitespaceOnly).toEqual([]);
  });

  it('the documented subset (ORDER_ID ... TYPE) is present and non-empty on the wire', () => {
    const report = diagnoseWireBody(body, DOCUMENTED_CHECK, fields);
    expect(report).toMatchObject({ missing: [], empty: [], whitespaceOnly: [] });
    const wire = new URLSearchParams(body);
    // Non-PII operational values only.
    expect({
      ORDER_ID: wire.get('ORDER_ID'),
      SPECIAL_INS: wire.get('SPECIAL_INS'),
      PICKUP_DATE: wire.get('PICKUP_DATE'),
      PICKUP_TIME: wire.get('PICKUP_TIME'),
      BRANCH: wire.get('BRANCH'),
      CUST_ID: wire.get('CUST_ID'),
      MERCHANT_ID: wire.get('MERCHANT_ID'),
      ORIGIN_CODE: wire.get('ORIGIN_CODE'),
      DESTINATION_CODE: wire.get('DESTINATION_CODE'),
      SERVICE_CODE: wire.get('SERVICE_CODE'),
      TYPE: wire.get('TYPE'),
    }).toEqual({
      ORDER_ID: 'BMS20260916MY5NMV4',
      SPECIAL_INS: 'NO SPECIAL INSTRUCTION',
      PICKUP_DATE: '17-09-2026',
      PICKUP_TIME: '17:00',
      BRANCH: 'BDO000',
      CUST_ID: 'MASSULAR',
      MERCHANT_ID: 'MASSULAR',
      ORIGIN_CODE: 'BDO10000',
      DESTINATION_CODE: 'BDO10060',
      SERVICE_CODE: 'JTR<130',
      TYPE: 'PICKUP',
    });
  });

  it('URL encoding round-trips losslessly (space -> +, < -> %3C, : -> %3A)', () => {
    expect(diagnoseWireBody(body, [], fields).encodingMismatches).toEqual([]);
    expect(body).toContain('SERVICE_CODE=JTR%3C130');
    expect(body).toContain('SPECIAL_INS=NO+SPECIAL+INSTRUCTION');
    expect(body).toContain('PICKUP_TIME=17%3A00');
    expect(body).not.toMatch(/^\s*[{[]/); // not JSON
  });

  it('the provider hands the transport exactly this body, as a form-encoded POST, once', async () => {
    const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
    const http: ShippingHttpClient = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => '{"error":"Please do not let paramaters empty.","status":false}', headers: { get: () => null } };
    };
    const provider = new JneShipmentProvider(shippingConfig());
    (provider as unknown as { http: ShippingHttpClient }).http = http;

    await provider.sendPickupCashless(fields);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://jne.invalid:10202/pickupcashless');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    expect(typeof init.body).toBe('string');
    expect(init.body).toBe(body);
  });

  it('fetch sends a string body with the explicit form Content-Type (no JSON, no multipart override)', async () => {
    // fetch only derives a Content-Type for URLSearchParams/FormData/Blob bodies; for a
    // STRING body it keeps the caller's header. Verified against Request, no network.
    const request = new Request('https://jne.invalid:10202/pickupcashless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(await request.text()).toBe(body);
  });

  it('the observed JNE top-level rejection is a provider error carrying its message', () => {
    expect(parseJnePickupCashlessResponse('{"error":"Please do not let paramaters empty.","status":false}')).toMatchObject({
      kind: 'provider_error',
      reason: 'Please do not let paramaters empty.',
    });
  });
});
