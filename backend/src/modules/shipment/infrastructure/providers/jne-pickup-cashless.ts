import { BUSINESS_TIMEZONE, zonedCivil } from '../../../../common/utils/business-time.util';
import { PermanentError } from '../../../shipping/domain/shipping-errors';
import { JnePickupConfig, jnePickupConfigIssues } from '../../../shipping/shipping.config';

/**
 * JNE `POST /pickupcashless` - request construction and response interpretation
 * (PURE: no I/O, no clock).
 *
 * JNE instructed the project to book through `/pickupcashless`. The REQUEST fields
 * come from JNE's documentation (supplied by the project owner). The SUCCESS
 * response was confirmed by JNE:
 *
 *   { "detail": [ { "status": "success", "cnote_no": "0109401600067399" } ] }
 *
 * and a business rejection was observed from JNE as HTTP 200 with
 *
 *   { "detail": [ { "status": "Error", "reason": "..." } ] }
 *
 * Nothing beyond those two shapes is assumed.
 *
 * SHIPPER_COUNTRY and RECEIVER_COUNTRY ARE sent (always INDONESIA): the documentation
 * marks them optional, but JNE confirmed both are mandatory for /pickupcashless.
 *
 * Deliberately NOT sent, because the documentation marks them optional or specific
 * to cases Mas Sular does not have: AWB (we never supply our own airwaybill), COD_*
 * (no channel offers COD), LAT/LON, and the Batam-only TAX_VALUE / ITEM_TYPE /
 * HS_CODE / NPWP.
 *
 * Deliberately NOT sent, because whether pickupcashless requires them is UNKNOWN and
 * must not be guessed: RETURN_*. An open question for JNE.
 */

/** The owning courier name, for PermanentError. */
const JNE = 'jne';

/**
 * JNE shipment booking must use REG service. Business requirement: every
 * `/pickupcashless` booking sends SERVICE_CODE=REG, whatever service the customer was
 * quoted and bought (e.g. `JTR<130`). Quotation, the price charged and the service
 * shown on the order/shipment are unaffected - only the booking request uses this.
 */
export const JNE_BOOKING_SERVICE_CODE = 'REG';

/**
 * SHIPPER_COUNTRY / RECEIVER_COUNTRY. JNE confirmed both fields are mandatory for
 * `/pickupcashless`. Hardcoded to INDONESIA for now, intentionally: every Mas Sular
 * shipment is domestic. Not configurable, not derived from the address, never taken
 * from customer input.
 */
export const JNE_BOOKING_COUNTRY = 'INDONESIA';

/** Documented field order - kept stable so serialized bodies are deterministic. */
export const JNE_PICKUP_CASHLESS_FIELDS = [
  'PICKUP_NAME',
  'PICKUP_DATE',
  'PICKUP_TIME',
  'PICKUP_PIC',
  'PICKUP_PIC_PHONE',
  'PICKUP_ADDRESS',
  'PICKUP_DISTRICT',
  'PICKUP_CITY',
  'PICKUP_SERVICE',
  'PICKUP_VEHICLE',
  'BRANCH',
  'CUST_ID',
  'ORDER_ID',
  'SHIPPER_NAME',
  'SHIPPER_ADDR1',
  'SHIPPER_ADDR2',
  'SHIPPER_CITY',
  'SHIPPER_ZIP',
  'SHIPPER_REGION',
  'SHIPPER_COUNTRY',
  'SHIPPER_CONTACT',
  'SHIPPER_PHONE',
  'RECEIVER_NAME',
  'RECEIVER_ADDR1',
  'RECEIVER_ADDR2',
  'RECEIVER_CITY',
  'RECEIVER_ZIP',
  'RECEIVER_REGION',
  'RECEIVER_COUNTRY',
  'RECEIVER_CONTACT',
  'RECEIVER_PHONE',
  'ORIGIN_CODE',
  'DESTINATION_CODE',
  'SERVICE_CODE',
  'WEIGHT',
  'QTY',
  'GOODS_DESC',
  'GOODS_AMOUNT',
  'INSURANCE_FLAG',
  'SPECIAL_INS',
  'MERCHANT_ID',
  'TYPE',
] as const;

export type JnePickupCashlessField = (typeof JNE_PICKUP_CASHLESS_FIELDS)[number];

/** Every documented field, always a string. Credentials are NOT part of this object. */
export type JnePickupCashlessFields = Record<JnePickupCashlessField, string>;

/** One order line as the builder needs it (the checkout-time snapshot). */
export interface JnePickupItem {
  name: string;
  quantity: number;
  /** Snapshot weight of ONE unit, grams. Null = never measured -> booking refused. */
  weightGram: number | null;
}

/** Everything order-specific the request needs, already loaded by the caller. */
export interface JnePickupCashlessSource {
  orderNumber: string;
  /**
   * The service the customer bought (e.g. `JTR<130`). Must be present (it marks a real
   * JNE selection) but is NOT sent: the booking always uses JNE_BOOKING_SERVICE_CODE.
   */
  service: string;
  /** Merchandise value: Order.subtotal (goods + toppings; no delivery/service fee, no voucher). */
  goodsAmount: number | undefined;
  /** JNE destination code from the verified district mapping; null = unmapped. */
  destinationCode: string | null;
  /** The pickup slot recorded on the shipment (ISO instant). */
  pickupAtIso: string | undefined;
  receiver: {
    name: string;
    phone?: string;
    addressDetail?: string;
    village?: string;
    district?: string;
    city?: string;
    postalCode: string;
    province?: string;
  };
  items: JnePickupItem[];
}

const present = (value: string | undefined | null): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Pickup date and time as JNE documents them - `DD-MM-YYYY` and 24-hour `HH:MM` -
 * read in the BUSINESS timezone (Asia/Jakarta), never UTC. The slot is stored as a
 * UTC instant, so formatting it without the zone would shift late-evening slots onto
 * the wrong calendar day.
 */
export function formatJnePickupSlot(pickupAtIso: string): { date: string; time: string } {
  const instant = new Date(pickupAtIso);
  if (Number.isNaN(instant.getTime())) {
    throw new PermanentError(`JNE pickup slot is not a valid instant ('${pickupAtIso}')`, JNE);
  }
  const c = zonedCivil(instant, BUSINESS_TIMEZONE);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return { date: `${pad(c.day)}-${pad(c.month)}-${pad(c.year, 4)}`, time: `${pad(c.hour)}:${pad(c.minute)}` };
}

/**
 * Parcel weight in whole kilograms from the REAL per-item snapshots:
 * SUM(weightGram x quantity) -> ceil to kg -> at least 1 kg. JNE bills by started
 * kilogram, the same rule the quote side already uses. Any item without a measured
 * weight refuses the booking: shipping on an invented weight is exactly what the
 * nullable snapshot exists to prevent.
 */
export function computeJneWeightKg(items: readonly JnePickupItem[]): number {
  if (items.length === 0) throw new PermanentError('JNE booking refused: the order has no items', JNE);
  const unmeasured = items.filter((item) => item.weightGram === null || !(item.weightGram > 0)).map((item) => item.name);
  if (unmeasured.length > 0) {
    throw new PermanentError(`JNE booking refused: no measured weight for ${[...new Set(unmeasured)].sort().join(', ')}`, JNE);
  }
  const grams = items.reduce((sum, item) => sum + (item.weightGram as number) * item.quantity, 0);
  return Math.max(1, Math.ceil(grams / 1000));
}

export function computeJneQuantity(items: readonly JnePickupItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * `Name xQty` per distinct product, sorted by name (code-point order, not the
 * locale's, so the output never depends on the host ICU). Lines for the same
 * product - e.g. with different toppings - are summed, because JNE describes goods,
 * not our order lines. NOT truncated: JNE's GOODS_DESC length limit is not
 * documented, and silently cutting the description is not an option.
 */
export function buildJneGoodsDesc(items: readonly JnePickupItem[]): string {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.name, (totals.get(item.name) ?? 0) + item.quantity);
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, quantity]) => `${name} x${quantity}`)
    .join(', ');
}

/**
 * RECEIVER_ADDR2 from the address hierarchy, in the admin's existing `Kel. / Kec.`
 * convention (admin/lib/format-address.ts). Empty when neither is known.
 */
export function buildReceiverAddr2(receiver: JnePickupCashlessSource['receiver']): string {
  return [present(receiver.village) ? `Kel. ${receiver.village.trim()}` : null, present(receiver.district) ? `Kec. ${receiver.district.trim()}` : null]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/** JNE's documented ORDER_ID limit. */
export const JNE_ORDER_ID_MAX_LENGTH = 20;

/**
 * SPECIAL_INS is mandatory for /pickupcashless. Mas Sular has no per-order courier
 * instruction, so the agreed static value is sent. Not stored anywhere.
 */
export const JNE_SPECIAL_INSTRUCTION = 'NO SPECIAL INSTRUCTION';

/**
 * The JNE ORDER_ID for a Mas Sular order number (business rule): remove EVERY "-",
 * then remove exactly the LAST character.
 *
 *   BMS-20260916-F5YMXSND -> BMS20260916F5YMXSND -> BMS20260916F5YMXSN (20)
 *
 * The Mas Sular order number stays the source of truth and is never modified; only
 * the value sent to JNE changes. Deterministic, no hashing, no other identifier.
 *
 * Refuses (PermanentError) rather than guessing when the input cannot produce a valid
 * ORDER_ID: not a string, blank, nothing left after the rule, or still longer than
 * JNE's 20-character limit (an unexpected, longer format is refused - never cut
 * further, which would silently break the mapping's meaning).
 */
export function toJneOrderId(orderNumber: unknown): string {
  if (typeof orderNumber !== 'string' || orderNumber.trim() === '') {
    throw new PermanentError('JNE ORDER_ID cannot be derived: the order number is missing', JNE);
  }
  const withoutHyphens = orderNumber.trim().replaceAll('-', '');
  if (withoutHyphens.length < 2) {
    throw new PermanentError(`JNE ORDER_ID cannot be derived from order number '${orderNumber}': too short`, JNE);
  }
  const orderId = withoutHyphens.slice(0, -1);
  if (orderId.length > JNE_ORDER_ID_MAX_LENGTH) {
    throw new PermanentError(
      `JNE ORDER_ID cannot be derived from order number '${orderNumber}': ${orderId.length} characters exceeds JNE's limit of ${JNE_ORDER_ID_MAX_LENGTH}`,
      JNE,
    );
  }
  return orderId;
}

/**
 * Build and validate every documented `/pickupcashless` field. Throws a
 * PermanentError naming ALL problems found, so an operator fixes them in one pass;
 * nothing here ever substitutes a default for a missing value.
 */
export function buildJnePickupCashlessFields(
  source: JnePickupCashlessSource,
  pickup: JnePickupConfig | undefined,
  originCode: string | undefined,
): JnePickupCashlessFields {
  const problems: string[] = [];

  for (const issue of jnePickupConfigIssues(pickup)) problems.push(issue);
  if (!present(originCode)) problems.push('JNE_ORIGIN_CODE is required');
  let jneOrderId = '';
  try {
    jneOrderId = toJneOrderId(source.orderNumber);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  if (!present(source.service)) problems.push('the selected JNE service is missing');
  if (!present(source.destinationCode)) {
    // Never the postal code: JNE keys off its own destination codes, and a postal
    // code in DESTINATION_CODE is exactly the mistake the old booking made.
    problems.push("the receiver's district has no approved JNE destination mapping (postal code is never used as a fallback)");
  }
  if (!present(source.pickupAtIso)) problems.push('no pickup slot is recorded on the shipment');
  if (source.goodsAmount === undefined || !Number.isInteger(source.goodsAmount) || source.goodsAmount < 0) {
    problems.push('the order merchandise value (subtotal) is missing or invalid');
  }

  const receiver = source.receiver;
  const receiverAddr1 = receiver.addressDetail?.trim() ?? '';
  const receiverAddr2 = buildReceiverAddr2(receiver);
  const receiverChecks: Array<[string, string | undefined]> = [
    ['RECEIVER_NAME', receiver.name],
    ['RECEIVER_ADDR1', receiverAddr1],
    ['RECEIVER_ADDR2 (village/district)', receiverAddr2],
    ['RECEIVER_CITY', receiver.city],
    ['RECEIVER_ZIP', receiver.postalCode],
    ['RECEIVER_REGION', receiver.province],
    ['RECEIVER_PHONE', receiver.phone],
  ];
  for (const [label, value] of receiverChecks) if (!present(value)) problems.push(`the order address has no ${label}`);

  // Weight throws its own precise error; collect it with the rest.
  let weightKg = 0;
  try {
    weightKg = computeJneWeightKg(source.items);
  } catch (err) {
    problems.push(err instanceof Error ? err.message.replace(/^JNE booking refused: /, '') : String(err));
  }

  let slot = { date: '', time: '' };
  if (present(source.pickupAtIso)) {
    try {
      slot = formatJnePickupSlot(source.pickupAtIso);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (problems.length > 0) {
    throw new PermanentError(`JNE booking refused before sending: ${problems.join('; ')}`, JNE);
  }

  const p = pickup as Required<JnePickupConfig>;
  return {
    PICKUP_NAME: p.pickupName,
    PICKUP_DATE: slot.date,
    PICKUP_TIME: slot.time,
    PICKUP_PIC: p.pickupPic,
    PICKUP_PIC_PHONE: p.pickupPicPhone,
    PICKUP_ADDRESS: p.pickupAddress,
    PICKUP_DISTRICT: p.pickupDistrict,
    PICKUP_CITY: p.pickupCity,
    PICKUP_SERVICE: p.pickupService,
    PICKUP_VEHICLE: p.pickupVehicle,
    BRANCH: p.branch,
    CUST_ID: p.custId,
    // Business rule (toJneOrderId): hyphens removed, last character removed, <= 20.
    ORDER_ID: jneOrderId,
    SHIPPER_NAME: p.shipperName,
    SHIPPER_ADDR1: p.shipperAddr1,
    SHIPPER_ADDR2: p.shipperAddr2,
    SHIPPER_CITY: p.shipperCity,
    SHIPPER_ZIP: p.shipperZip,
    SHIPPER_REGION: p.shipperRegion,
    // Hardcoded (JNE requires it; every shipment is domestic) - see JNE_BOOKING_COUNTRY.
    SHIPPER_COUNTRY: JNE_BOOKING_COUNTRY,
    SHIPPER_CONTACT: p.shipperContact,
    SHIPPER_PHONE: p.shipperPhone,
    RECEIVER_NAME: receiver.name.trim(),
    RECEIVER_ADDR1: receiverAddr1,
    RECEIVER_ADDR2: receiverAddr2,
    RECEIVER_CITY: (receiver.city as string).trim(),
    RECEIVER_ZIP: receiver.postalCode.trim(),
    RECEIVER_REGION: (receiver.province as string).trim(),
    // Hardcoded (JNE requires it; every shipment is domestic) - see JNE_BOOKING_COUNTRY.
    RECEIVER_COUNTRY: JNE_BOOKING_COUNTRY,
    // The address model has no separate contact field: the recipient IS the contact.
    RECEIVER_CONTACT: receiver.name.trim(),
    RECEIVER_PHONE: (receiver.phone as string).trim(),
    ORIGIN_CODE: (originCode as string).trim(),
    DESTINATION_CODE: (source.destinationCode as string).trim(),
    // JNE shipment booking must use REG service (business requirement), regardless of
    // the quoted/selected service in source.service.
    SERVICE_CODE: JNE_BOOKING_SERVICE_CODE,
    WEIGHT: String(weightKg),
    QTY: String(computeJneQuantity(source.items)),
    GOODS_DESC: buildJneGoodsDesc(source.items),
    GOODS_AMOUNT: String(source.goodsAmount),
    // No insurance feature exists for JNE in Mas Sular; `N` is the documented value.
    INSURANCE_FLAG: 'N',
    SPECIAL_INS: JNE_SPECIAL_INSTRUCTION,
    MERCHANT_ID: p.merchantId,
    TYPE: p.type,
  };
}

/**
 * `application/x-www-form-urlencoded` body: credentials first, then every documented
 * field in documented order. Refuses a non-string value outright, so `undefined` or
 * `null` can never be serialized as the literal text "undefined" / "null".
 */
export function serializeJnePickupCashless(
  credentials: { username: string | undefined; apiKey: string | undefined },
  fields: JnePickupCashlessFields,
): string {
  if (!present(credentials.username) || !present(credentials.apiKey)) {
    throw new PermanentError('JNE booking refused before sending: JNE_USERNAME and JNE_API_KEY are required', JNE);
  }
  const form = new URLSearchParams();
  form.append('username', credentials.username);
  form.append('api_key', credentials.apiKey);
  for (const key of JNE_PICKUP_CASHLESS_FIELDS) {
    const value: unknown = fields[key];
    if (typeof value !== 'string') {
      throw new PermanentError(`JNE booking refused before sending: ${key} has no value`, JNE);
    }
    form.append(key, value);
  }
  return form.toString();
}

// ------------------------------------------------------------------ response --

/** How a `/pickupcashless` answer was interpreted. Exactly one of three outcomes. */
export type JnePickupCashlessResult =
  /** `detail[0].status` is success AND `detail[0].cnote_no` is a non-empty string. */
  | { kind: 'success'; cnote: string; payload: unknown }
  /**
   * JNE refused the pickup: a well-formed `detail[0]` whose status is not success, or
   * JNE's top-level rejection `{ "error": "<message>", "status": false }`.
   */
  | { kind: 'provider_error'; reason: string; payload: unknown }
  /** Anything else - not the confirmed contract, so nothing is concluded from it. */
  | { kind: 'malformed'; problem: string; payload: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Interpret a `/pickupcashless` body against the CONFIRMED contract only.
 *
 * - SUCCESS requires both halves: `status` is "success" AND `cnote_no` is a non-empty
 *   string. HTTP 200 alone never means success, and no other field is ever read as an
 *   AWB. The status comparison ignores case and surrounding whitespace only.
 * - "success" WITHOUT a usable cnote_no is MALFORMED, not a rejection: JNE claimed to
 *   accept, so the answer must not be reported as a refusal.
 * - Any other status on a well-formed `detail[0]` is JNE refusing the pickup; its
 *   `reason` is kept when present.
 * - With no `detail` array, the OBSERVED top-level rejection
 *   `{ "error": "<message>", "status": false }` is also JNE refusing the pickup, with
 *   `error` as the reason. It needs the boolean `false` and a non-blank `error`
 *   string; anything short of that stays malformed.
 */
export function parseJnePickupCashlessResponse(text: string): JnePickupCashlessResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'malformed', problem: 'the response is not valid JSON', payload: text };
  }
  if (!isObject(payload)) return { kind: 'malformed', problem: 'the response is not a JSON object', payload };

  const detail = payload.detail;
  if (!Array.isArray(detail)) {
    if (payload.status === false && typeof payload.error === 'string' && payload.error.trim() !== '') {
      return { kind: 'provider_error', reason: payload.error.trim(), payload };
    }
    return { kind: 'malformed', problem: 'the response has no detail array', payload };
  }
  if (detail.length === 0) return { kind: 'malformed', problem: 'the response detail array is empty', payload };

  const first = detail[0];
  if (!isObject(first)) return { kind: 'malformed', problem: 'detail[0] is not an object', payload };
  if (typeof first.status !== 'string' || first.status.trim() === '') {
    return { kind: 'malformed', problem: 'detail[0].status is missing', payload };
  }

  if (first.status.trim().toLowerCase() === 'success') {
    const cnote = typeof first.cnote_no === 'string' ? first.cnote_no.trim() : '';
    if (cnote === '') {
      return { kind: 'malformed', problem: 'detail[0].status is success but detail[0].cnote_no is missing or empty', payload };
    }
    return { kind: 'success', cnote, payload };
  }

  const reason =
    typeof first.reason === 'string' && first.reason.trim() !== ''
      ? first.reason.trim()
      : `status "${first.status.trim()}" without a reason`;
  return { kind: 'provider_error', reason, payload };
}
