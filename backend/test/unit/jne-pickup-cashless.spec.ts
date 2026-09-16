import {
  buildJneGoodsDesc,
  buildJnePickupCashlessFields,
  buildReceiverAddr2,
  computeJneQuantity,
  computeJneWeightKg,
  formatJnePickupSlot,
  JNE_PICKUP_CASHLESS_FIELDS,
  JNE_ORDER_ID_MAX_LENGTH,
  JNE_SPECIAL_INSTRUCTION,
  JnePickupCashlessSource,
  parseJnePickupCashlessResponse,
  serializeJnePickupCashless,
  toJneOrderId,
} from '../../src/modules/shipment/infrastructure/providers/jne-pickup-cashless';
import { PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { JnePickupConfig } from '../../src/modules/shipping/shipping.config';
import { REDACTED, REDACTED_PII, sanitizeBody } from '../../src/infrastructure/integration-log/integration-log.sanitizer';

/**
 * JNE POST /pickupcashless — request construction (JNE's documented fields) and
 * response interpretation (JNE's CONFIRMED success body and the observed HTTP-200
 * rejection). Placeholder request values are test fixtures, not real JNE data.
 */

const PICKUP: Required<JnePickupConfig> = {
  pickupName: 'Mas Sular Outlet Test',
  pickupPic: 'Pic Test',
  pickupPicPhone: '081200000001',
  pickupAddress: 'Jl. Gudang Test No. 1',
  pickupDistrict: 'Sumur Bandung',
  pickupCity: 'Kota Bandung',
  pickupService: 'Domestic',
  pickupVehicle: 'Motor',
  branch: 'BRANCH-TEST',
  custId: 'CUST-TEST',
  merchantId: 'MERCHANT-TEST',
  shipperName: 'Mas Sular Test',
  shipperAddr1: 'Jl. Gudang Test No. 1',
  shipperAddr2: 'Kel. Braga',
  shipperCity: 'Kota Bandung',
  shipperZip: '40111',
  shipperRegion: 'Jawa Barat',
  shipperContact: 'Shipper Contact Test',
  shipperPhone: '081200000002',
  type: 'PICKUP',
};

/** 2026-09-17 17:00 WIB (Asia/Jakarta, UTC+7) as the stored UTC instant. */
const SLOT_ISO = '2026-09-17T10:00:00.000Z';

const SOURCE: JnePickupCashlessSource = {
  orderNumber: 'BMS-20260916-RYXWQSGR',
  service: 'JTR<130',
  goodsAmount: 85_000,
  destinationCode: 'BDO10060',
  pickupAtIso: SLOT_ISO,
  receiver: {
    name: 'Budi Santoso',
    phone: '085861470308',
    addressDetail: 'Jl. Veteran No. 65',
    village: 'Kebon Pisang',
    district: 'Sumur Bandung',
    city: 'Kota Bandung',
    postalCode: '40112',
    province: 'Jawa Barat',
  },
  items: [
    { name: 'Baso Urat Jumbo', quantity: 2, weightGram: 250 },
    { name: 'Es Teh Manis', quantity: 1, weightGram: 200 },
  ],
};

const build = (over: Partial<JnePickupCashlessSource> = {}, pickup: JnePickupConfig | undefined = PICKUP, origin: string | undefined = 'BDO10000') =>
  buildJnePickupCashlessFields({ ...SOURCE, ...over }, pickup, origin);

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PermanentError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('field mapping', () => {
  const fields = build();

  it('produces EXACTLY the documented field set, every value a string', () => {
    expect(Object.keys(fields).sort()).toEqual([...JNE_PICKUP_CASHLESS_FIELDS].sort());
    for (const value of Object.values(fields)) expect(typeof value).toBe('string');
    // Not sent: our own AWB, COD, coordinates, Batam fields, and the unknown RETURN_*.
    for (const absent of ['AWB', 'COD_FLAG', 'COD_AMOUNT', 'LAT', 'LON', 'TAX_VALUE', 'ITEM_TYPE', 'HS_CODE', 'NPWP', 'RETURN_NAME', 'RETURN_BRANCH', 'OLSHOP_GOODSVALUE']) {
      expect(fields).not.toHaveProperty(absent);
    }
  });

  it('pickup fields come from configuration', () => {
    expect(fields).toMatchObject({
      PICKUP_NAME: PICKUP.pickupName,
      PICKUP_PIC: PICKUP.pickupPic,
      PICKUP_PIC_PHONE: PICKUP.pickupPicPhone,
      PICKUP_ADDRESS: PICKUP.pickupAddress,
      PICKUP_DISTRICT: PICKUP.pickupDistrict,
      PICKUP_CITY: PICKUP.pickupCity,
      PICKUP_SERVICE: 'Domestic',
      PICKUP_VEHICLE: 'Motor',
      BRANCH: PICKUP.branch,
      CUST_ID: PICKUP.custId,
      MERCHANT_ID: PICKUP.merchantId,
      TYPE: 'PICKUP',
    });
  });

  it('shipper fields come from configuration', () => {
    expect(fields).toMatchObject({
      SHIPPER_NAME: PICKUP.shipperName,
      SHIPPER_ADDR1: PICKUP.shipperAddr1,
      SHIPPER_ADDR2: PICKUP.shipperAddr2,
      SHIPPER_CITY: PICKUP.shipperCity,
      SHIPPER_ZIP: PICKUP.shipperZip,
      SHIPPER_REGION: PICKUP.shipperRegion,
      SHIPPER_CONTACT: PICKUP.shipperContact,
      SHIPPER_PHONE: PICKUP.shipperPhone,
    });
  });

  it('receiver fields come from the order address', () => {
    expect(fields).toMatchObject({
      RECEIVER_NAME: 'Budi Santoso',
      RECEIVER_ADDR1: 'Jl. Veteran No. 65',
      RECEIVER_ADDR2: 'Kel. Kebon Pisang, Kec. Sumur Bandung',
      RECEIVER_CITY: 'Kota Bandung',
      RECEIVER_ZIP: '40112',
      RECEIVER_REGION: 'Jawa Barat',
      // No distinct contact field exists in the address model: the recipient is the contact.
      RECEIVER_CONTACT: 'Budi Santoso',
      RECEIVER_PHONE: '085861470308',
    });
  });

  it('routing: JNE origin code, the resolved JNE destination code, the selected service', () => {
    expect(fields.ORIGIN_CODE).toBe('BDO10000');
    expect(fields.DESTINATION_CODE).toBe('BDO10060');
    expect(fields.SERVICE_CODE).toBe('JTR<130');
  });

  it('goods: weight, quantity, description, merchandise amount, insurance', () => {
    // 2 x 250 g + 1 x 200 g = 700 g -> ceil -> 1 kg
    expect(fields.WEIGHT).toBe('1');
    expect(fields.QTY).toBe('3');
    expect(fields.GOODS_DESC).toBe('Baso Urat Jumbo x2, Es Teh Manis x1');
    expect(fields.GOODS_AMOUNT).toBe('85000'); // Order.subtotal, not totalPrice
    expect(fields.INSURANCE_FLAG).toBe('N');
    expect(fields.SPECIAL_INS).toBe('NO SPECIAL INSTRUCTION');
  });

  it('ORDER_ID follows the business rule; the Mas Sular order number itself is untouched', () => {
    expect(fields.ORDER_ID).toBe('BMS20260916RYXWQSG');
    expect(fields.ORDER_ID.length).toBeLessThanOrEqual(20);
    expect(SOURCE.orderNumber).toBe('BMS-20260916-RYXWQSGR');
  });

  it('SPECIAL_INS sits directly after INSURANCE_FLAG in the documented field order', () => {
    const index = JNE_PICKUP_CASHLESS_FIELDS.indexOf('SPECIAL_INS');
    expect(JNE_PICKUP_CASHLESS_FIELDS[index - 1]).toBe('INSURANCE_FLAG');
    expect(JNE_SPECIAL_INSTRUCTION).toBe('NO SPECIAL INSTRUCTION');
  });

  it('pickup date/time come from the recorded slot, in JNE format', () => {
    expect(fields.PICKUP_DATE).toBe('17-09-2026');
    expect(fields.PICKUP_TIME).toBe('17:00');
  });
});

describe('pickup date and time — DD-MM-YYYY, HH:MM, Asia/Jakarta', () => {
  it.each([
    ['a normal afternoon slot', '2026-09-17T10:00:00.000Z', '17-09-2026', '17:00'],
    ['UTC evening becomes the NEXT day in Jakarta', '2026-09-17T17:30:00.000Z', '18-09-2026', '00:30'],
    ['month boundary (Jan 31 UTC -> Feb 1 WIB)', '2026-01-31T18:00:00.000Z', '01-02-2026', '01:00'],
    ['year boundary (Dec 31 UTC -> Jan 1 WIB)', '2026-12-31T17:15:00.000Z', '01-01-2027', '00:15'],
    ['leap day', '2028-02-29T02:05:00.000Z', '29-02-2028', '09:05'],
    ['midnight is 00, never 24', '2026-09-17T17:00:00.000Z', '18-09-2026', '00:00'],
  ])('%s', (_label, iso, date, time) => {
    expect(formatJnePickupSlot(iso)).toEqual({ date, time });
  });

  it('an unparseable slot is refused', () => {
    expect(() => formatJnePickupSlot('not-a-date')).toThrow(PermanentError);
  });

  it('a missing slot refuses the booking - the current time is never substituted', () => {
    expect(refusal(() => build({ pickupAtIso: undefined }))).toMatch(/no pickup slot is recorded/);
  });
});

describe('destination — the verified JNE code, never the postal code', () => {
  it('an unmapped district refuses the booking, explicitly without a postal-code fallback', () => {
    const message = refusal(() => build({ destinationCode: null }));
    expect(message).toMatch(/no approved JNE destination mapping/);
    expect(message).toMatch(/postal code is never used as a fallback/);
  });

  it('the postal code never appears as DESTINATION_CODE', () => {
    const fields = build();
    expect(fields.DESTINATION_CODE).not.toBe(SOURCE.receiver.postalCode);
    expect(fields.RECEIVER_ZIP).toBe(SOURCE.receiver.postalCode); // it only goes where JNE asks for a ZIP
  });
});

describe('weight — real snapshots, ceil to kg, minimum 1 kg', () => {
  it.each([
    ['multiple items and quantities', [{ name: 'A', quantity: 3, weightGram: 400 }, { name: 'B', quantity: 2, weightGram: 300 }], 2], // 1800 g
    ['exactly 1000 g stays 1 kg', [{ name: 'A', quantity: 4, weightGram: 250 }], 1],
    ['1001 g ceils to 2 kg', [{ name: 'A', quantity: 1, weightGram: 1001 }], 2],
    ['a very light parcel is at least 1 kg', [{ name: 'A', quantity: 1, weightGram: 1 }], 1],
  ])('%s', (_label, items, kg) => {
    expect(computeJneWeightKg(items)).toBe(kg);
  });

  it('a missing item weight refuses and names the item', () => {
    expect(() => computeJneWeightKg([{ name: 'Tanpa Berat', quantity: 1, weightGram: null }])).toThrow(/no measured weight for Tanpa Berat/);
    expect(refusal(() => build({ items: [{ name: 'Tanpa Berat', quantity: 1, weightGram: null }] }))).toMatch(/Tanpa Berat/);
  });

  it('a zero or negative weight is not a measurement', () => {
    expect(() => computeJneWeightKg([{ name: 'Nol', quantity: 1, weightGram: 0 }])).toThrow(PermanentError);
  });

  it('an order with no items is refused', () => {
    expect(() => computeJneWeightKg([])).toThrow(/no items/);
  });

  it('quantity is the sum of item quantities', () => {
    expect(computeJneQuantity([{ name: 'A', quantity: 2, weightGram: 1 }, { name: 'B', quantity: 5, weightGram: 1 }])).toBe(7);
  });
});

describe('goods description — deterministic', () => {
  it('sorts by name and sums lines of the same product', () => {
    const items = [
      { name: 'Es Teh Manis', quantity: 1, weightGram: 200 },
      { name: 'Baso Urat Jumbo', quantity: 1, weightGram: 250 },
      { name: 'Baso Urat Jumbo', quantity: 2, weightGram: 250 }, // same product, other toppings
    ];
    expect(buildJneGoodsDesc(items)).toBe('Baso Urat Jumbo x3, Es Teh Manis x1');
    expect(buildJneGoodsDesc([...items].reverse())).toBe(buildJneGoodsDesc(items));
  });

  it('is not truncated (JNE has not documented a length limit)', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ name: `Produk Nomor ${String(i).padStart(2, '0')}`, quantity: 1, weightGram: 100 }));
    expect(buildJneGoodsDesc(long).split(', ')).toHaveLength(40);
  });
});

describe('refusals collect every problem, and never substitute defaults', () => {
  it('missing configuration names each environment variable', () => {
    const message = refusal(() => build({}, { ...PICKUP, custId: undefined, type: undefined, branch: '' }));
    for (const key of ['JNE_CUST_ID', 'JNE_TYPE', 'JNE_BRANCH']) expect(message).toContain(`${key} is required`);
  });

  it('no pickup configuration at all refuses', () => {
    // Called directly: passing `undefined` to build() would trigger its default parameter.
    expect(refusal(() => buildJnePickupCashlessFields(SOURCE, undefined, 'BDO10000'))).toContain('JNE_PICKUP_NAME is required');
  });

  it('an invalid enum value is refused with the documented options', () => {
    const message = refusal(() => build({}, { ...PICKUP, pickupVehicle: 'Pesawat', pickupService: 'domestic', type: 'pickup' }));
    expect(message).toContain('JNE_PICKUP_VEHICLE must be one of Motor | Mobil | Truck');
    expect(message).toContain('JNE_PICKUP_SERVICE must be one of Domestic | Intracity | All'); // case-sensitive
    expect(message).toContain('JNE_TYPE must be one of DROP | PICKUP');
  });

  it('an order number that cannot yield an ORDER_ID is refused with the rest', () => {
    expect(refusal(() => build({ orderNumber: '' }))).toMatch(/order number is missing/);
    expect(refusal(() => build({ orderNumber: 'BMS-20260916-THIS-IS-FAR-TOO-LONG' }))).toMatch(/exceeds JNE's limit of 20/);
  });

  it('missing origin code, subtotal, or receiver data', () => {
    expect(refusal(() => buildJnePickupCashlessFields(SOURCE, PICKUP, undefined))).toContain('JNE_ORIGIN_CODE is required');
    expect(refusal(() => build({ goodsAmount: undefined }))).toMatch(/merchandise value/);
    expect(refusal(() => build({ goodsAmount: 1.5 }))).toMatch(/merchandise value/);
    expect(refusal(() => build({ receiver: { ...SOURCE.receiver, province: undefined } }))).toContain('RECEIVER_REGION');
    expect(refusal(() => build({ receiver: { ...SOURCE.receiver, phone: '  ' } }))).toContain('RECEIVER_PHONE');
    expect(refusal(() => build({ receiver: { ...SOURCE.receiver, village: undefined, district: undefined } }))).toContain('RECEIVER_ADDR2');
  });

  it('several problems are reported together, in one error', () => {
    const message = refusal(() => build({ destinationCode: null, pickupAtIso: undefined, items: [{ name: 'X', quantity: 1, weightGram: null }] }));
    expect(message).toMatch(/destination mapping/);
    expect(message).toMatch(/pickup slot/);
    expect(message).toMatch(/no measured weight for X/);
  });

  it('RECEIVER_ADDR2 uses whichever of village / district exists', () => {
    expect(buildReceiverAddr2({ ...SOURCE.receiver, village: undefined })).toBe('Kec. Sumur Bandung');
    expect(buildReceiverAddr2({ ...SOURCE.receiver, district: '' })).toBe('Kel. Kebon Pisang');
  });
});

describe('serialization — application/x-www-form-urlencoded', () => {
  const credentials = { username: 'user-test', apiKey: 'key-test' };

  it('credentials first, then every documented field in documented order', () => {
    const body = serializeJnePickupCashless(credentials, build());
    const keys = [...new URLSearchParams(body).keys()];
    expect(keys).toEqual(['username', 'api_key', ...JNE_PICKUP_CASHLESS_FIELDS]);
  });

  it('round-trips losslessly, including symbols and Indonesian addresses', () => {
    const tricky = build({
      service: 'JTR<130',
      receiver: {
        ...SOURCE.receiver,
        name: 'Siti "Ani" Rahmawati',
        addressDetail: 'Jl. Merdeka No. 12/B, RT 01/RW 02 & Gg. Mawar #3 (belakang masjid) 100%',
      },
    });
    const body = serializeJnePickupCashless(credentials, tricky);
    // Encoded on the wire...
    expect(body).toContain('SERVICE_CODE=JTR%3C130');
    expect(body).not.toContain('& Gg.');
    expect(body).not.toContain('#3');
    // ...and decoded back exactly.
    const decoded = Object.fromEntries(new URLSearchParams(body));
    expect(decoded.SERVICE_CODE).toBe('JTR<130');
    expect(decoded.RECEIVER_NAME).toBe('Siti "Ani" Rahmawati');
    expect(decoded.RECEIVER_ADDR1).toBe('Jl. Merdeka No. 12/B, RT 01/RW 02 & Gg. Mawar #3 (belakang masjid) 100%');
    expect(decoded.username).toBe('user-test');
  });

  it('SPECIAL_INS and the derived ORDER_ID are in the final form body', () => {
    const body = serializeJnePickupCashless(credentials, build());
    expect(body).toContain('SPECIAL_INS=NO+SPECIAL+INSTRUCTION');
    expect(body).toContain('ORDER_ID=BMS20260916RYXWQSG&');
    const decoded = Object.fromEntries(new URLSearchParams(body));
    expect(decoded.INSURANCE_FLAG).toBe('N');
    expect(decoded.SPECIAL_INS).toBe('NO SPECIAL INSTRUCTION');
    expect(decoded.ORDER_ID).toBe('BMS20260916RYXWQSG');
  });

  it('never serializes the literal text "undefined" or "null"', () => {
    const decoded = [...new URLSearchParams(serializeJnePickupCashless(credentials, build())).values()];
    expect(decoded).not.toContain('undefined');
    expect(decoded).not.toContain('null');
    expect(decoded.every((v) => v.length > 0)).toBe(true);
  });

  it('refuses a missing value instead of stringifying it', () => {
    const broken = { ...build(), GOODS_AMOUNT: undefined } as unknown as ReturnType<typeof build>;
    expect(() => serializeJnePickupCashless(credentials, broken)).toThrow(/GOODS_AMOUNT has no value/);
  });

  it('refuses missing credentials', () => {
    expect(() => serializeJnePickupCashless({ username: undefined, apiKey: 'k' }, build())).toThrow(/JNE_USERNAME and JNE_API_KEY are required/);
    expect(() => serializeJnePickupCashless({ username: 'u', apiKey: '' }, build())).toThrow(PermanentError);
  });
});

describe('what the integration log would persist from this exact body', () => {
  const body = serializeJnePickupCashless({ username: 'user-SECRET', apiKey: 'key-SECRET-123' }, build());
  const stored = sanitizeBody(body, 'application/x-www-form-urlencoded') as Record<string, unknown>;
  const json = JSON.stringify(stored);

  it('credentials are unrecoverable', () => {
    expect(stored.username).toBe(REDACTED);
    expect(stored.api_key).toBe(REDACTED);
    expect(json).not.toContain('key-SECRET-123');
    expect(json).not.toContain('user-SECRET');
  });

  it('receiver, shipper and pickup PII is masked', () => {
    for (const key of ['RECEIVER_NAME', 'RECEIVER_ADDR1', 'RECEIVER_ADDR2', 'RECEIVER_CONTACT', 'RECEIVER_PHONE', 'SHIPPER_NAME', 'SHIPPER_ADDR1', 'SHIPPER_ADDR2', 'SHIPPER_CONTACT', 'SHIPPER_PHONE', 'PICKUP_NAME', 'PICKUP_PIC', 'PICKUP_PIC_PHONE', 'PICKUP_ADDRESS']) {
      expect([key, stored[key]]).toEqual([key, REDACTED_PII]);
    }
    for (const value of ['Budi Santoso', '085861470308', 'Jl. Veteran', 'Kebon Pisang', 'Pic Test', '081200000001', '081200000002', 'Jl. Gudang Test']) {
      expect(json).not.toContain(value);
    }
  });

  it('operational fields stay readable for troubleshooting', () => {
    expect(stored).toMatchObject({
      ORDER_ID: 'BMS20260916RYXWQSG',
      SPECIAL_INS: 'NO SPECIAL INSTRUCTION',
      ORIGIN_CODE: 'BDO10000',
      DESTINATION_CODE: 'BDO10060',
      SERVICE_CODE: 'JTR<130',
      WEIGHT: '1',
      QTY: '3',
      GOODS_AMOUNT: '85000',
      INSURANCE_FLAG: 'N',
      PICKUP_DATE: '17-09-2026',
      PICKUP_TIME: '17:00',
      PICKUP_SERVICE: 'Domestic',
      PICKUP_VEHICLE: 'Motor',
      RECEIVER_CITY: 'Kota Bandung',
      RECEIVER_ZIP: '40112',
      TYPE: 'PICKUP',
    });
  });
});

describe('response — the CONFIRMED contract only', () => {
  /** Exactly the success body JNE confirmed. */
  const CONFIRMED_SUCCESS = '{"detail":[{"status":"success","cnote_no":"0109401600067399"}]}';
  /** Exactly the HTTP-200 rejection JNE returned for the earlier generatecnote attempt. */
  const OBSERVED_ERROR = '{"detail":[{"reason":"Please do not let field OLSHOP_GOODSVALUE empty","status":"Error"}]}';

  it('SUCCESS: status "success" + cnote_no -> the cnote, nothing else', () => {
    expect(parseJnePickupCashlessResponse(CONFIRMED_SUCCESS)).toEqual({
      kind: 'success',
      cnote: '0109401600067399',
      payload: { detail: [{ status: 'success', cnote_no: '0109401600067399' }] },
    });
  });

  it('the cnote is taken verbatim (whitespace trimmed, leading zeros kept, no numeric coercion)', () => {
    const result = parseJnePickupCashlessResponse('{"detail":[{"status":"success","cnote_no":"  0109401600067399 "}]}');
    expect(result).toMatchObject({ kind: 'success', cnote: '0109401600067399' });
  });

  it('status comparison ignores only case and surrounding whitespace', () => {
    expect(parseJnePickupCashlessResponse('{"detail":[{"status":" Success ","cnote_no":"X1"}]}')).toMatchObject({ kind: 'success', cnote: 'X1' });
    expect(parseJnePickupCashlessResponse('{"detail":[{"status":"successful","cnote_no":"X1"}]}')).toMatchObject({ kind: 'provider_error' });
  });

  it('BUSINESS ERROR: HTTP-200 "Error" is NOT success, and the reason is preserved', () => {
    expect(parseJnePickupCashlessResponse(OBSERVED_ERROR)).toEqual({
      kind: 'provider_error',
      reason: 'Please do not let field OLSHOP_GOODSVALUE empty',
      payload: { detail: [{ reason: 'Please do not let field OLSHOP_GOODSVALUE empty', status: 'Error' }] },
    });
  });

  it('a rejection without a reason still names the status it was given', () => {
    expect(parseJnePickupCashlessResponse('{"detail":[{"status":"Error"}]}')).toMatchObject({
      kind: 'provider_error',
      reason: 'status "Error" without a reason',
    });
  });

  it('an error status never yields an AWB, even when a cnote_no is present', () => {
    const result = parseJnePickupCashlessResponse('{"detail":[{"status":"Error","reason":"duplicate","cnote_no":"0109401600067399"}]}');
    expect(result.kind).toBe('provider_error');
    expect(result).not.toHaveProperty('cnote');
  });

  it.each([
    ['malformed JSON', '{"detail":[{"status":', /not valid JSON/],
    ['HTML error page', '<html>502 Bad Gateway</html>', /not valid JSON/],
    ['empty body', '', /not valid JSON/],
    ['a JSON array', '[{"status":"success","cnote_no":"1"}]', /not a JSON object/],
    ['a JSON string', '"success"', /not a JSON object/],
    ['JSON null', 'null', /not a JSON object/],
    ['a number', '42', /not a JSON object/],
    ['missing detail', '{"status":"success","cnote_no":"0109401600067399"}', /no detail array/],
    ['detail not an array', '{"detail":{"status":"success","cnote_no":"1"}}', /no detail array/],
    ['empty detail', '{"detail":[]}', /detail array is empty/],
    ['detail[0] not an object', '{"detail":["success"]}', /detail\[0\] is not an object/],
    ['missing status', '{"detail":[{"cnote_no":"0109401600067399"}]}', /status is missing/],
    ['blank status', '{"detail":[{"status":"  ","cnote_no":"1"}]}', /status is missing/],
    ['status success but missing cnote_no', '{"detail":[{"status":"success"}]}', /cnote_no is missing or empty/],
    ['status success with empty cnote_no', '{"detail":[{"status":"success","cnote_no":""}]}', /cnote_no is missing or empty/],
    ['status success with whitespace cnote_no', '{"detail":[{"status":"success","cnote_no":"   "}]}', /cnote_no is missing or empty/],
    ['status success with a numeric cnote_no', '{"detail":[{"status":"success","cnote_no":109401600067399}]}', /cnote_no is missing or empty/],
  ])('MALFORMED: %s', (_label, body, problem) => {
    const result = parseJnePickupCashlessResponse(body);
    expect(result.kind).toBe('malformed');
    expect((result as { problem: string }).problem).toMatch(problem);
  });

  it('no other field is ever read as an AWB (awb / cnote.cnote_no / airwaybill are not the contract)', () => {
    for (const body of [
      '{"detail":[{"status":"success","awb":"0109401600067399"}]}',
      '{"detail":[{"status":"success"}],"cnote":{"cnote_no":"0109401600067399"}}',
      '{"detail":[{"status":"success","airwaybill_code":"0109401600067399"}]}',
    ]) {
      expect(parseJnePickupCashlessResponse(body).kind).toBe('malformed');
    }
  });

  it('only detail[0] decides (the confirmed contract)', () => {
    const body = '{"detail":[{"status":"Error","reason":"first entry"},{"status":"success","cnote_no":"LATER"}]}';
    expect(parseJnePickupCashlessResponse(body)).toMatchObject({ kind: 'provider_error', reason: 'first entry' });
  });
});

describe('toJneOrderId — the business rule', () => {
  it('the documented example: BMS-20260916-F5YMXSND -> BMS20260916F5YMXSN', () => {
    expect(toJneOrderId('BMS-20260916-F5YMXSND')).toBe('BMS20260916F5YMXSN');
  });

  it('removes EVERY "-"', () => {
    expect(toJneOrderId('BMS-20260916-F5YMXSND')).not.toContain('-');
    expect(toJneOrderId('A-B-C-D-E')).toBe('ABCD');
  });

  it('removes exactly the LAST character (after the hyphens are gone)', () => {
    expect(toJneOrderId('BMS-20260916-F5YMXSND').endsWith('N')).toBe(true); // the final "D" is gone
    expect(toJneOrderId('AB-C')).toBe('AB');
    expect(toJneOrderId('ABCD-')).toBe('ABC'); // a trailing hyphen is removed first, then "D"
  });

  it('the real order-number format always fits JNE\'s limit (21 -> 18 characters)', () => {
    const orderId = toJneOrderId('BMS-20260916-F5YMXSND');
    expect('BMS-20260916-F5YMXSND').toHaveLength(21);
    expect(orderId).toHaveLength(18);
    expect(orderId.length).toBeLessThanOrEqual(JNE_ORDER_ID_MAX_LENGTH);
    expect(JNE_ORDER_ID_MAX_LENGTH).toBe(20);
  });

  it('is deterministic and never hashes or invents an identifier', () => {
    expect(toJneOrderId('BMS-20260916-F5YMXSND')).toBe(toJneOrderId('BMS-20260916-F5YMXSND'));
    expect(toJneOrderId('BMS-20260916-F5YMXSND')).toMatch(/^BMS20260916F5YMXSN$/);
  });

  it('does not modify the value it is given', () => {
    const orderNumber = 'BMS-20260916-F5YMXSND';
    toJneOrderId(orderNumber);
    expect(orderNumber).toBe('BMS-20260916-F5YMXSND');
  });

  it('surrounding whitespace is ignored', () => {
    expect(toJneOrderId('  BMS-20260916-F5YMXSND  ')).toBe('BMS20260916F5YMXSN');
  });

  it.each([
    ['undefined', undefined, /order number is missing/],
    ['null', null, /order number is missing/],
    ['a number', 20260916, /order number is missing/],
    ['an empty string', '', /order number is missing/],
    ['whitespace', '   ', /order number is missing/],
    ['only hyphens', '---', /too short/],
    ['a single character', 'A', /too short/],
    ['a single character with hyphens', '-A-', /too short/],
  ])('refuses %s', (_label, input, message) => {
    expect(() => toJneOrderId(input)).toThrow(PermanentError);
    expect(() => toJneOrderId(input)).toThrow(message);
  });

  it('refuses an unexpectedly LONG format instead of cutting it further', () => {
    // BMS20260916F5YMXSNDEXTRA (24) minus its last character = 23: refused, never cut to 20.
    expect(() => toJneOrderId('BMS-20260916-F5YMXSND-EXTRA')).toThrow(/23 characters exceeds JNE's limit of 20/);
    // Exactly 20 after the rule is accepted.
    expect(toJneOrderId('ABCDEFGHIJKLMNOPQRSTU')).toHaveLength(20);
  });
});
