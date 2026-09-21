import {
  buildJnePickupCashlessFields,
  JNE_PICKUP_CASHLESS_FIELDS,
  JnePickupCashlessSource,
  parseJnePickupCashlessResponse,
  serializeJnePickupCashless,
} from '../../src/modules/shipment/infrastructure/providers/jne-pickup-cashless';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
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

  it('has 44 unique keys, in documented order, with no renaming, casing change or duplicate', () => {
    const report = diagnoseWireBody(body, allMandatory, { ...fields, username: CREDENTIALS.username, api_key: CREDENTIALS.apiKey });
    expect(report.keys).toEqual(['username', 'api_key', ...JNE_PICKUP_CASHLESS_FIELDS]);
    expect(report.keys).toHaveLength(44); // 42 + SHIPPER_COUNTRY + RECEIVER_COUNTRY
    expect(report.duplicates).toEqual([]);
    expect(report.unexpectedKeys).toEqual([]);
    expect(report.nonAsciiOrControlKeys).toEqual([]);
  });

  it('SHIPPER_COUNTRY / RECEIVER_COUNTRY = INDONESIA on the wire, right after each *_REGION; SERVICE_CODE stays REG', () => {
    const wire = new URLSearchParams(body);
    expect(body).toContain('&PICKUP_SERVICE=REG&PICKUP_VEHICLE=Mobil&');
    expect([wire.get('SHIPPER_COUNTRY'), wire.get('RECEIVER_COUNTRY'), wire.get('SERVICE_CODE')]).toEqual(['INDONESIA', 'INDONESIA', 'REG']);
    expect(body).toContain('&SHIPPER_REGION=Jawa+Barat&SHIPPER_COUNTRY=INDONESIA&SHIPPER_CONTACT=');
    expect(body).toContain('&RECEIVER_REGION=Jawa+Barat&RECEIVER_COUNTRY=INDONESIA&RECEIVER_CONTACT=');
    expect(body).toContain('&ORIGIN_CODE=BDO10000&DESTINATION_CODE=BDO10060&SERVICE_CODE=REG&WEIGHT=1&QTY=1&');
  });

  it('existing booking fields are unchanged: without the two country fields the wire is exactly the previous 42 keys', () => {
    const PREVIOUS_KEYS = [
      'username', 'api_key',
      'PICKUP_NAME', 'PICKUP_DATE', 'PICKUP_TIME', 'PICKUP_PIC', 'PICKUP_PIC_PHONE', 'PICKUP_ADDRESS', 'PICKUP_DISTRICT', 'PICKUP_CITY',
      'PICKUP_SERVICE', 'PICKUP_VEHICLE', 'BRANCH', 'CUST_ID', 'ORDER_ID',
      'SHIPPER_NAME', 'SHIPPER_ADDR1', 'SHIPPER_ADDR2', 'SHIPPER_CITY', 'SHIPPER_ZIP', 'SHIPPER_REGION', 'SHIPPER_CONTACT', 'SHIPPER_PHONE',
      'RECEIVER_NAME', 'RECEIVER_ADDR1', 'RECEIVER_ADDR2', 'RECEIVER_CITY', 'RECEIVER_ZIP', 'RECEIVER_REGION', 'RECEIVER_CONTACT', 'RECEIVER_PHONE',
      'ORIGIN_CODE', 'DESTINATION_CODE', 'SERVICE_CODE', 'WEIGHT', 'QTY', 'GOODS_DESC', 'GOODS_AMOUNT', 'INSURANCE_FLAG', 'SPECIAL_INS',
      'MERCHANT_ID', 'TYPE',
    ];
    const pairs = [...new URLSearchParams(body)].filter(([key]) => key !== 'SHIPPER_COUNTRY' && key !== 'RECEIVER_COUNTRY');
    expect(pairs.map(([key]) => key)).toEqual(PREVIOUS_KEYS);
    // Values of the pre-existing operational fields are unchanged too.
    expect(Object.fromEntries(pairs)).toMatchObject({
      PICKUP_SERVICE: 'REG', TYPE: 'PICKUP', INSURANCE_FLAG: 'N', BRANCH: 'BDO000', WEIGHT: '1', QTY: '1', GOODS_AMOUNT: '45000',
    });
    // Nothing else was added: still no AWB / COD / LAT / LON / ADDR3 / RETURN_*.
    for (const absent of ['AWB', 'COD_FLAG', 'COD_AMOUNT', 'LAT', 'LON', 'SHIPPER_ADDR3', 'RECEIVER_ADDR3', 'RETURN_NAME']) {
      expect([absent, new URLSearchParams(body).has(absent)]).toEqual([absent, false]);
    }
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
      SERVICE_CODE: 'REG', // JNE shipment booking must use REG (SOURCE.service is JTR<130)
      TYPE: 'PICKUP',
    });
  });

  it('URL encoding round-trips losslessly (space -> +, : -> %3A); SERVICE_CODE is REG, never the quoted JTR<130', () => {
    expect(diagnoseWireBody(body, [], fields).encodingMismatches).toEqual([]);
    expect(body).toContain('SERVICE_CODE=REG&');
    expect(body).not.toContain('JTR');
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

describe('quotation -> booking: the booking sends REG whatever the quote said', () => {
  // Real quotation provider (JNE pricedev) and real booking provider, both with a mocked
  // transport - no network. The quotation answers JTR<130; the customer "buys" it.
  const PRICEDEV_BODY = JSON.stringify({
    price: [
      { origin_name: 'BANDUNG', destination_name: 'BANDUNG', service_display: 'JTR<130', service_code: 'JTR<130', goods_type: 'Paket', currency: 'IDR', price: '50000', etd_from: '3', etd_thru: '4', times: 'D' },
      { origin_name: 'BANDUNG', destination_name: 'BANDUNG', service_display: 'YES', service_code: 'YES19', goods_type: 'Document/Paket', currency: 'IDR', price: '15000', etd_from: null, etd_thru: null, times: 'D' },
    ],
  });
  const response = (status: number, text: string) => ({ status, text: async () => text, headers: { get: () => null } });
  const resolver = { resolve: async () => 'BDO10060' } as never;

  async function quote() {
    const calls: string[] = [];
    const quotation = new JneProvider(shippingConfig(), resolver);
    (quotation as unknown as { http: ShippingHttpClient }).http = async (url) => {
      calls.push(url);
      return response(200, PRICEDEV_BODY);
    };
    const quotes = await quotation.getRates({ originPostalCode: '40111', destinationPostalCode: '40112', weightGram: 250, destinationDistrictId: 'dist-1' });
    return { quotes, calls };
  }

  async function book(service: string) {
    const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
    const booking = new JneShipmentProvider(shippingConfig(), undefined, resolver);
    (booking as unknown as { http: ShippingHttpClient }).http = async (url, init) => {
      calls.push({ url, init });
      return response(200, '{"detail":[{"status":"success","cnote_no":"0109401600067399"}]}');
    };
    const result = await booking.createShipment({
      orderId: 'order-1',
      orderNumber: SOURCE.orderNumber,
      service,
      weightGram: 250,
      origin: { name: 'Outlet', postalCode: '40111' },
      destination: {
        name: SOURCE.receiver.name,
        phone: SOURCE.receiver.phone,
        addressDetail: SOURCE.receiver.addressDetail,
        village: SOURCE.receiver.village,
        district: SOURCE.receiver.district,
        city: SOURCE.receiver.city,
        postalCode: SOURCE.receiver.postalCode,
        province: SOURCE.receiver.province,
      },
      goodsAmount: SOURCE.goodsAmount,
      destinationDistrictId: 'dist-1',
      recordedPickupAtIso: SOURCE.pickupAtIso,
      items: [{ code: 'P1', name: 'Keju Nyakrek', category: 'Food', quantity: 1, unitPrice: 45_000, weightGram: 250, lengthCm: null, widthCm: null, heightCm: null }],
    } as never);
    return { result, calls };
  }

  it('the quotation is unchanged (JTR<130 returned verbatim) and makes no booking request', async () => {
    const { quotes, calls } = await quote();
    expect(quotes.map((q) => q.service)).toEqual(['JTR<130', 'YES19']);
    expect(quotes.find((q) => q.service === 'JTR<130')?.shippingCost).toBe(50_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://jne.invalid:10202/tracing/api/pricedev');
    expect(calls.some((url) => url.includes('/pickupcashless'))).toBe(false);
  });

  it('booking the quoted JTR<130 sends PICKUP_SERVICE=REG, SERVICE_CODE=REG, SHIPPER_COUNTRY / RECEIVER_COUNTRY=INDONESIA in the one /pickupcashless request', async () => {
    const { quotes } = await quote();
    const quoted = quotes.find((q) => q.service === 'JTR<130')!;
    const { result, calls } = await book(quoted.service);

    expect(result.trackingNumber).toBe('0109401600067399');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://jne.invalid:10202/pickupcashless');
    const wire = new URLSearchParams(String(calls[0].init.body));
    expect(wire.get('SERVICE_CODE')).toBe('REG');
    expect(wire.get('PICKUP_SERVICE')).toBe('REG');
    expect([wire.get('TYPE'), wire.get('INSURANCE_FLAG')]).toEqual(['PICKUP', 'N']);
    expect(wire.get('SHIPPER_COUNTRY')).toBe('INDONESIA');
    expect(wire.get('RECEIVER_COUNTRY')).toBe('INDONESIA');
    expect(String(calls[0].init.body)).not.toContain('JTR');
    // The quote object itself was not modified by booking.
    expect(quoted.service).toBe('JTR<130');
  });

  it.each(['JTR<130', 'JTR250', 'YES19', 'REG19', 'REG15', 'SOMETHING_NEW'])('booking a quoted %s sends PICKUP_SERVICE=REG, SERVICE_CODE=REG and both countries', async (service) => {
    const { calls } = await book(service);
    const wire = new URLSearchParams(String(calls[0].init.body));
    expect([wire.get('PICKUP_SERVICE'), wire.get('SERVICE_CODE'), wire.get('SHIPPER_COUNTRY'), wire.get('RECEIVER_COUNTRY')]).toEqual(['REG', 'REG', 'INDONESIA', 'INDONESIA']);
  });

  it('every other booking field is exactly what the builder produces for this order', async () => {
    const { calls } = await book('JTR<130');
    expect(calls[0].init.body).toBe(serializeJnePickupCashless(CREDENTIALS, buildJnePickupCashlessFields({ ...SOURCE, service: 'JTR<130' }, PICKUP, 'BDO10000')));
  });
});
