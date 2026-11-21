import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import {
  buildJneDestinationSnapshot,
  buildJnePickupCashlessFields,
  JNE_DESTINATION_SNAPSHOT_FIELDS,
  jneAddressLineTruncated,
  JnePickupCashlessSource,
} from '../../src/modules/shipment/infrastructure/providers/jne-pickup-cashless';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';
import { PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { JnePickupConfig, ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpClient, ShippingHttpRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * Shipment.destinationSnapshot (Print Resi hardening): each provider returns the
 * receiver fields it ACTUALLY submitted - read from the very request object it
 * serialized - and only for a successful booking. Mocked transports only: no
 * request ever leaves the process (test/setup/no-external-network.ts).
 */

const PICKUP: Required<JnePickupConfig> = {
  pickupName: 'Placeholder Outlet', pickupPic: 'Placeholder Pic', pickupPicPhone: '080000000001',
  pickupAddress: 'Jl. Placeholder No. 1', pickupDistrict: 'Buahbatu', pickupCity: 'Bandung', pickupService: 'Domestic',
  pickupVehicle: 'Mobil', branch: 'BDO000', custId: 'MASSULAR', merchantId: 'MASSULAR', shipperName: 'Placeholder Shipper',
  shipperAddr1: 'Jl. Placeholder No. 1', shipperAddr2: 'Kel. Placeholder', shipperCity: 'Bandung', shipperZip: '40286',
  shipperRegion: 'Jawa Barat', shipperContact: 'Placeholder Contact', shipperPhone: '080000000002', type: 'PICKUP',
};
const CREDENTIALS = { username: 'placeholder-user', apiKey: 'placeholder-key' };
const LONG_DETAIL = 'Jl. Melati No. 5 RT 02/RW 03, Komplek Griya Asri Blok C-17';

const response = (status: number, text: string) => ({ status, text: async () => text, headers: { get: () => null } });

function jneConfig(): ShippingConfig {
  return {
    allowMockRates: false,
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid', timeoutMs: 1000, maxRetry: 0 },
    paxel: { enabled: false, baseUrl: 'https://paxel.invalid', timeoutMs: 1000, maxRetry: 0 },
    jne: {
      enabled: true, environment: 'sandbox', baseUrl: 'https://jne.invalid:10202',
      username: CREDENTIALS.username, apiKey: CREDENTIALS.apiKey, originCode: 'BDO10000', timeoutMs: 1000, maxRetry: 0, pickup: PICKUP,
    },
  } as unknown as ShippingConfig;
}

function jneInput(over: Partial<CreateShipmentInput['destination']> = {}): CreateShipmentInput {
  return {
    orderId: 'order-1',
    orderNumber: 'BMS-20260916-MY5NMV4X',
    service: 'REG23',
    weightGram: 250,
    origin: { name: 'Outlet', postalCode: '40111' },
    destination: {
      name: ' Siti Aminah ',
      phone: '081234567890',
      addressDetail: `${LONG_DETAIL}\nDekat masjid`,
      village: 'Lengkong',
      district: 'Bojongsoang',
      city: 'Kabupaten Bandung',
      postalCode: '40287',
      province: 'Jawa Barat',
      note: 'Pagar hijau',
      ...over,
    },
    goodsAmount: 45_000,
    destinationDistrictId: 'dist-1',
    recordedPickupAtIso: '2026-09-17T10:00:00.000Z',
    items: [{ code: 'P1', name: 'Bakso', category: 'Food', quantity: 1, unitPrice: 45_000, weightGram: 250, lengthCm: null, widthCm: null, heightCm: null, isFragile: null }],
  };
}

function jneBooking(body: string, status = 200) {
  const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
  const provider = new JneShipmentProvider(jneConfig(), undefined, { resolve: async () => 'BDO10060' } as never);
  (provider as unknown as { http: ShippingHttpClient }).http = async (url, init) => {
    calls.push({ url, init });
    return response(status, body);
  };
  return { provider, calls };
}

const JNE_OK = '{"detail":[{"status":"success","cnote_no":"0291492600000050"}]}';

describe('JNE booking — destination snapshot of the submitted /pickupcashless fields', () => {
  it('equals the receiver fields of the wire body exactly (after JNE transformations)', async () => {
    const { provider, calls } = jneBooking(JNE_OK);
    const result = await provider.createShipment(jneInput());
    const wire = new URLSearchParams(calls[0].init.body as string);
    const snap = result.destinationSnapshot!;

    expect(snap.version).toBe(1);
    expect(snap.provider).toBe('jne');
    expect(Number.isNaN(Date.parse(snap.capturedAt))).toBe(false);
    for (const field of JNE_DESTINATION_SNAPSHOT_FIELDS) expect(snap.providerFields[field]).toBe(wire.get(field));
    expect(Object.keys(snap.providerFields).sort()).toEqual([...JNE_DESTINATION_SNAPSHOT_FIELDS].sort());
    expect(snap.recipientName).toBe(wire.get('RECEIVER_NAME')); // trimmed as sent: 'Siti Aminah'
    expect(snap.recipientName).toBe('Siti Aminah');
    expect(snap.addressLines).toEqual([wire.get('RECEIVER_ADDR1'), wire.get('RECEIVER_ADDR2')]);
    expect([snap.city, snap.province, snap.postalCode, snap.phone]).toEqual([
      wire.get('RECEIVER_CITY'), wire.get('RECEIVER_REGION'), wire.get('RECEIVER_ZIP'), wire.get('RECEIVER_PHONE'),
    ]);
    // Village/district are not separate JNE fields (they are inside RECEIVER_ADDR2); no address note is sent.
    expect([snap.village, snap.district, snap.note]).toEqual([null, null, null]);
  });

  it('reflects the 30-character truncation accurately and says so', async () => {
    const { provider } = jneBooking(JNE_OK);
    const snap = (await provider.createShipment(jneInput())).destinationSnapshot!;
    expect(snap.addressLines[0]).toBe('Jl. Melati No. 5 RT 02/RW 03, ');
    expect(Array.from(snap.addressLines[0])).toHaveLength(30);
    expect(snap.addressLines[1]).toBe('Kel. Lengkong, Kec. Bojongsoan');
    expect(snap.addressTruncated).toBe(true);
  });

  it('a short address is not flagged as truncated (whitespace/line-break normalization alone is not truncation)', async () => {
    const { provider } = jneBooking(JNE_OK);
    const snap = (await provider.createShipment(jneInput({ addressDetail: 'Jl. Mawar\n  No. 1', village: 'Cipagalo', district: 'Dayeuh' }))).destinationSnapshot!;
    expect(snap.addressLines).toEqual(['Jl. Mawar No. 1', 'Kel. Cipagalo, Kec. Dayeuh']);
    expect(snap.addressTruncated).toBe(false);
    expect(jneAddressLineTruncated('a'.repeat(30))).toBe(false);
    expect(jneAddressLineTruncated('a'.repeat(31))).toBe(true);
    expect(jneAddressLineTruncated(`${'a'.repeat(15)}\n\n   ${'b'.repeat(14)}`)).toBe(false);
  });

  it('never carries credentials, shipper/pickup data, items or values', async () => {
    const { provider } = jneBooking(JNE_OK);
    const snap = (await provider.createShipment(jneInput())).destinationSnapshot!;
    const json = JSON.stringify(snap);
    for (const secret of [CREDENTIALS.username, CREDENTIALS.apiKey, PICKUP.shipperName, PICKUP.pickupPicPhone, 'GOODS_AMOUNT', 'SHIPPER_', 'PICKUP_', 'api_key']) {
      expect(json).not.toContain(secret);
    }
  });

  it('a refused booking returns no snapshot (it throws before a result exists)', async () => {
    const { provider } = jneBooking('{"detail":[{"status":"Error","reason":"Destination not served"}]}');
    await expect(provider.createShipment(jneInput())).rejects.toBeInstanceOf(PermanentError);
  });

  it('the pure builder reads the given fields only', () => {
    const source: JnePickupCashlessSource = {
      orderNumber: 'BMS-20260916-MY5NMV4X', service: 'REG', goodsAmount: 1, destinationCode: 'BDO10060', pickupAtIso: '2026-09-17T10:00:00.000Z',
      receiver: { name: 'A', phone: '0812', addressDetail: 'Jl. A', village: 'V', district: 'D', city: 'C', postalCode: '40000', province: 'P' },
      items: [{ name: 'X', quantity: 1, weightGram: 100 }],
    };
    const fields = buildJnePickupCashlessFields(source, PICKUP, 'BDO10000');
    const snap = buildJneDestinationSnapshot(fields, source.receiver, new Date('2026-11-20T00:00:00.000Z'));
    expect(snap).toEqual({
      version: 1, provider: 'jne', capturedAt: '2026-11-20T00:00:00.000Z', recipientName: 'A', phone: '0812',
      addressLines: ['Jl. A', 'Kel. V, Kec. D'], village: null, district: null, city: 'C', province: 'P', postalCode: '40000', note: null,
      addressTruncated: false,
      providerFields: {
        RECEIVER_NAME: 'A', RECEIVER_ADDR1: 'Jl. A', RECEIVER_ADDR2: 'Kel. V, Kec. D', RECEIVER_CITY: 'C', RECEIVER_ZIP: '40000',
        RECEIVER_REGION: 'P', RECEIVER_COUNTRY: 'INDONESIA', RECEIVER_CONTACT: 'A', RECEIVER_PHONE: '0812', DESTINATION_CODE: 'BDO10060',
      },
    });
  });
});

/* ------------------------------------ Paxel ------------------------------------ */

function paxelConfig(): ShippingConfig {
  return {
    allowMockRates: false,
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 1 },
    paxel: {
      enabled: true, baseUrl: 'https://stage-commerce-api.paxel.test/v1', apiKey: 'test-api-key-not-a-real-secret',
      apiSecret: 'test-api-secret-not-a-real-secret', originPhone: '081212121212', originNote: 'gerbang samping',
      timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  } as unknown as ShippingConfig;
}

function paxelInput(destination: Partial<CreateShipmentInput['destination']> = {}): CreateShipmentInput {
  return {
    orderId: 'order-1', orderNumber: 'BMS-000123', service: 'PAXEL_REGULAR', weightGram: 900, invoiceValue: 250000,
    paymentMethod: 'BANK_TRANSFER', pickupAtIso: '2026-09-01T10:30:00.000Z',
    origin: { name: 'Bakso Mas Sular Pusat', postalCode: '40111', addressDetail: 'Jl. Outlet No.1', province: 'Jawa Barat', city: 'Kota Bandung', district: 'Coblong', village: 'Dago', latitude: -6.91, longitude: 107.6 },
    destination: {
      name: 'Budi Santoso', phone: '089191919191', addressDetail: `${LONG_DETAIL}, dekat masjid besar`, note: 'pagar hijau', postalCode: '40131',
      province: 'Jawa Barat', city: 'Kota Bandung', district: 'Sukajadi', village: 'Pasteur', latitude: -6.9, longitude: 107.6, ...destination,
    },
    goodsAmount: 90000,
    items: [{ productId: 'prod-001', code: 'SKU-001', name: 'Bakso Urat', category: 'Makanan', quantity: 2, unitPrice: 45000, weightGram: 450, lengthCm: 20, widthCm: 15, heightCm: 10, isFragile: false }],
  };
}

function paxelBooking(status: number, body: string) {
  const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
  const provider = new PaxelShipmentProvider(paxelConfig());
  (provider as unknown as { http: ShippingHttpClient }).http = async (url, init) => {
    calls.push({ url, init });
    return response(status, body);
  };
  return { provider, calls };
}

const PAXEL_OK = JSON.stringify({ message: 'OK', status_code: 200, data: { airwaybill_code: 'CO.EMSULAR-20261030-1-CYOCBX', shipping_cost: 30000 } });

describe('Paxel booking — destination snapshot of the submitted `destination`', () => {
  it('equals the sent destination object (full address, never shortened), minus coordinates', async () => {
    const { provider, calls } = paxelBooking(200, PAXEL_OK);
    const result = await provider.createShipment(paxelInput());
    const sent = JSON.parse(calls[0].init.body as string).destination;
    const snap = result.destinationSnapshot!;

    const { latitude, longitude, ...sentWithoutCoordinates } = sent;
    expect([latitude, longitude]).toEqual([-6.9, 107.6]);
    expect(snap.providerFields).toEqual(sentWithoutCoordinates);
    expect(snap).toMatchObject({
      version: 1, provider: 'paxel', recipientName: sent.name, phone: sent.phone, addressLines: [sent.address],
      village: sent.village, district: sent.district, city: sent.city, province: sent.province, postalCode: sent.zip_code,
      note: sent.note, addressTruncated: false, coordinatesSubmitted: true,
    });
    expect(snap.addressLines[0].length).toBeGreaterThan(30);
    expect(JSON.stringify(snap)).not.toMatch(/latitude|longitude|-6\.9|107\.6|test-api-(key|secret)|SKU-001|invoice/);
  });

  it('no note and no coordinates: absent, not invented', async () => {
    const { provider } = paxelBooking(200, PAXEL_OK);
    const snap = (await provider.createShipment(paxelInput({ note: undefined, latitude: undefined, longitude: undefined }))).destinationSnapshot!;
    expect(snap.note).toBeNull();
    expect(snap.providerFields).not.toHaveProperty('note');
    expect(snap.coordinatesSubmitted).toBe(false);
  });

  it('a failed booking returns no snapshot (it throws)', async () => {
    await expect(paxelBooking(422, '{"message":"invalid"}').provider.createShipment(paxelInput())).rejects.toBeInstanceOf(PermanentError);
    await expect(paxelBooking(200, '{"data":{}}').provider.createShipment(paxelInput())).rejects.toBeInstanceOf(PermanentError);
  });
});
