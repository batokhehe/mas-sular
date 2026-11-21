/**
 * Print Resi (Admin Order Detail) — PURE view model for the 100 x 150 mm packing slip.
 *
 * Built ONLY from the Order Detail payload the page already loaded
 * (GET /admin/orders/:id): no extra request, no React, no DOM, no runtime imports
 * (so `node --test` runs it without loaders). Nothing here writes anything.
 *
 * Data sources (traced in the Print Resi audit):
 *  - recipient, in priority order (resolveRecipient):
 *      1. Shipment.destinationSnapshot — what the courier was actually sent;
 *      2. Order.recipientSnapshot — the recipient as validated at checkout;
 *      3. Order.address — the LIVE saved address (legacy orders), labelled as such.
 *    Never integration logs or raw provider payloads.
 *  - items: OrderItem snapshots (productName, quantity, spicyLevel, notes) and
 *    OrderItemTopping.name. Never prices.
 *  - courier: Shipment.provider ('jne' | 'paxel'), else the checkout snapshot
 *    Order.shippingProvider.
 *  - AWB: Shipment.trackingNumber (set by the JNE/Paxel booking or an admin edit),
 *    else Order.trackingNumber (the mirror written in the same transaction). Used
 *    EXACTLY as stored — never the order number, never a placeholder.
 */

export interface PrintResiRegion {
  name: string;
}

/** The subset of AdminOrderDetail the slip reads (structural, so tests can build it). */
export interface PrintResiOrderInput {
  orderNumber: string;
  createdAt: string;
  shippingProvider?: string | null;
  shippingServiceName?: string | null;
  shippingService?: string | null;
  trackingNumber?: string | null;
  outlet?: { name: string } | null;
  reservations?: ReadonlyArray<{ outlet?: { name: string } | null }> | null;
  address?: {
    recipientName: string;
    phone: string;
    fullAddress: string;
    notes?: string | null;
    addressDetail?: string | null;
    postalCode?: string | null;
    province?: PrintResiRegion | null;
    city?: PrintResiRegion | null;
    district?: PrintResiRegion | null;
    village?: (PrintResiRegion & { postalCode?: string | null }) | null;
  } | null;
  /** Order.recipientSnapshot (JSON; validated before use). */
  recipientSnapshot?: unknown;
  items: ReadonlyArray<{
    id: string;
    productName: string;
    quantity: number;
    spicyLevel?: number | null;
    notes?: string | null;
    toppings?: ReadonlyArray<{ name: string }> | null;
  }>;
  shipment?: {
    provider: string;
    service: string;
    trackingNumber?: string | null;
    /** Shipment.destinationSnapshot (JSON; validated before use). */
    destinationSnapshot?: unknown;
  } | null;
}

export type ResiCourier = 'jne' | 'paxel';

export interface PrintResiItem {
  key: string;
  productName: string;
  quantity: number;
  /** Chosen product options (the order stores spicy level as its only variant). */
  options: string[];
  /** Add-on / topping names as snapshotted on the order. */
  toppings: string[];
  notes: string | null;
}

export interface PrintResiView {
  orderNumber: string;
  /** Asia/Jakarta, e.g. "30 Oktober 2026, 11:39 WIB". */
  orderDate: string;
  outlet: string;
  recipient: {
    /** Where the recipient block came from (see resolveRecipient). */
    source: RecipientSource;
    /** Shown on the slip when the source needs qualifying (live address, shortened courier address). */
    notice: string | null;
    name: string;
    phone: string | null;
    /** Street / detail lines, as stored or as submitted to the courier. */
    addressLines: string[];
    /** Present regions only: "Kel. …", "Kec. …", city, province. */
    regionLines: string[];
    postalCode: string | null;
    /** Address note (landmark) the customer gave, if any. */
    note: string | null;
  };
  items: PrintResiItem[];
  shipment: {
    courier: ResiCourier | null;
    /** "JNE", "Paxel", or the raw provider id upper-cased. */
    courierName: string;
    serviceName: string | null;
    /** The exact persisted AWB, or null. */
    awb: string | null;
  };
}

export type RecipientSource = 'shipment' | 'order' | 'live' | 'none';

export const RECIPIENT_NOTICE = {
  live: 'Alamat tersimpan saat ini (pesanan lama tanpa salinan alamat checkout).',
  // The printed lines are the checkout address; the courier holds a shortened copy.
  truncatedWithCheckout: 'Alamat lengkap sesuai checkout. Data yang dikirim ke kurir disingkat (maks. 30 karakter/baris), jadi tidak sama persis.',
  // The printed lines are the submitted ones. We shortened them before sending (JNE's limit).
  truncated: 'Alamat sesuai data yang dikirim ke kurir, sudah disingkat (maks. 30 karakter/baris) sehingga tidak lengkap.',
} as const;

/** Why a slip cannot be printed. Null = printable. */
export type PrintResiBlocker = 'awb-missing' | 'awb-unencodable' | 'no-address';

export const PRINT_RESI_BLOCKER_MESSAGE: Record<PrintResiBlocker, string> = {
  'awb-missing': 'Resi belum bisa dicetak: nomor Resi/AWB belum tersedia untuk pesanan ini.',
  'awb-unencodable': 'Resi tidak bisa dicetak: nomor Resi/AWB berisi karakter yang tidak dapat dijadikan barcode.',
  'no-address': 'Resi tidak bisa dicetak: alamat penerima pesanan tidak ditemukan.',
};

/** Courier logos, copied into admin/public/print from the storefront's assets. */
export const COURIER_LOGO_SRC: Readonly<Record<ResiCourier, string>> = {
  jne: '/print/jne-logo.jpg',
  paxel: '/print/paxel-logo.jpeg',
};
export const MAS_SULAR_LOGO_SRC = '/print/mas-sular-logo.png';

const COURIER_NAME: Readonly<Record<ResiCourier, string>> = { jne: 'JNE', paxel: 'Paxel' };

const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Deterministic Indonesian date-time in Asia/Jakarta (month names not ICU-dependent). */
export function formatResiDate(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)) {
    parts[type] = value;
  }
  return `${Number(parts.day)} ${MONTHS_ID[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} WIB`;
}

export function resiCourier(provider: string | null | undefined): ResiCourier | null {
  const id = (provider ?? '').trim().toLowerCase();
  return id === 'jne' || id === 'paxel' ? id : null;
}

/** Logo for a known courier, else null (the slip then prints the courier name as text). */
export function courierLogoSrc(courier: ResiCourier | null): string | null {
  return courier ? COURIER_LOGO_SRC[courier] : null;
}

/** The persisted AWB, exactly as stored (whitespace-only counts as missing). */
export function persistedAwb(order: Pick<PrintResiOrderInput, 'shipment' | 'trackingNumber'>): string | null {
  if (present(order.shipment?.trackingNumber)) return order.shipment.trackingNumber;
  if (present(order.trackingNumber)) return order.trackingNumber;
  return null;
}

/** Same rule as the Code 128 encoder: non-empty printable ASCII only. */
function isBarcodeSafe(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return value.length > 0;
}

export function printResiBlocker(order: PrintResiOrderInput): PrintResiBlocker | null {
  const awb = persistedAwb(order);
  if (!awb) return 'awb-missing';
  if (!isBarcodeSafe(awb)) return 'awb-unencodable';
  if (resolveRecipient(order).source === 'none') return 'no-address';
  return null;
}

type OrderSnapshot = {
  recipientName: string; phone: string; addressDetail: string | null; fullAddress: string;
  village: string | null; district: string | null; city: string | null; province: string | null;
  postalCode: string | null; note: string | null;
};
type ShipmentSnapshot = {
  recipientName: string; phone: string | null; addressLines: string[];
  village: string | null; district: string | null; city: string | null; province: string | null;
  postalCode: string | null; note: string | null; addressTruncated: boolean;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Order.recipientSnapshot v1, or null when absent / not a shape this version understands. */
export function readOrderSnapshot(value: unknown): OrderSnapshot | null {
  if (!isObj(value) || value.version !== 1 || !str(value.recipientName)) return null;
  return {
    recipientName: value.recipientName as string,
    phone: typeof value.phone === 'string' ? value.phone : '',
    addressDetail: str(value.addressDetail),
    fullAddress: typeof value.fullAddress === 'string' ? value.fullAddress : '',
    village: str(value.village), district: str(value.district), city: str(value.city), province: str(value.province),
    postalCode: str(value.postalCode), note: str(value.note),
  };
}

/** Shipment.destinationSnapshot v1, or null when absent / unknown version. */
export function readShipmentSnapshot(value: unknown): ShipmentSnapshot | null {
  if (!isObj(value) || value.version !== 1 || !str(value.recipientName) || !Array.isArray(value.addressLines)) return null;
  return {
    recipientName: value.recipientName as string,
    phone: str(value.phone),
    addressLines: value.addressLines.filter((line): line is string => typeof line === 'string' && line.trim() !== ''),
    village: str(value.village), district: str(value.district), city: str(value.city), province: str(value.province),
    postalCode: str(value.postalCode), note: str(value.note),
    addressTruncated: value.addressTruncated === true,
  };
}

function regionLinesOf(r: { village?: string | null; district?: string | null; city?: string | null; province?: string | null }): string[] {
  return [
    present(r.village) ? `Kel. ${r.village}` : null,
    present(r.district) ? `Kec. ${r.district}` : null,
    present(r.city) ? r.city : null,
    present(r.province) ? r.province : null,
  ].filter((line): line is string => line !== null);
}

/**
 * The recipient block, by source priority:
 *  1. Shipment.destinationSnapshot (booked): what the courier holds. If the courier
 *     request SHORTENED the address (JNE, 30 chars/line) and the checkout snapshot
 *     exists, the street/region lines come from the checkout snapshot instead - the
 *     packer gets the full address, and the slip says the courier's copy is shorter.
 *     Name, phone and postal code stay the submitted ones.
 *  2. Order.recipientSnapshot: the recipient as validated at checkout.
 *  3. Order.address: the LIVE saved address (legacy orders) - labelled as such.
 */
export function resolveRecipient(order: Pick<PrintResiOrderInput, 'address' | 'recipientSnapshot' | 'shipment'>): PrintResiView['recipient'] {
  const fromShipment = readShipmentSnapshot(order.shipment?.destinationSnapshot);
  const fromOrder = readOrderSnapshot(order.recipientSnapshot);

  if (fromShipment) {
    const useCheckoutLines = fromShipment.addressTruncated && fromOrder !== null;
    return {
      source: 'shipment',
      notice: fromShipment.addressTruncated ? (useCheckoutLines ? RECIPIENT_NOTICE.truncatedWithCheckout : RECIPIENT_NOTICE.truncated) : null,
      name: fromShipment.recipientName,
      phone: fromShipment.phone,
      addressLines: useCheckoutLines ? [fromOrder.addressDetail ?? fromOrder.fullAddress].filter(present) : fromShipment.addressLines,
      regionLines: useCheckoutLines ? regionLinesOf(fromOrder) : regionLinesOf(fromShipment),
      postalCode: fromShipment.postalCode ?? (useCheckoutLines ? fromOrder.postalCode : null),
      note: fromShipment.note ?? (useCheckoutLines ? fromOrder.note : null),
    };
  }
  if (fromOrder) {
    return {
      source: 'order',
      notice: null,
      name: fromOrder.recipientName,
      phone: present(fromOrder.phone) ? fromOrder.phone : null,
      addressLines: [fromOrder.addressDetail ?? fromOrder.fullAddress].filter(present),
      regionLines: regionLinesOf(fromOrder),
      postalCode: fromOrder.postalCode,
      note: fromOrder.note,
    };
  }
  const address = order.address ?? null;
  if (!address) {
    return { source: 'none', notice: null, name: '—', phone: null, addressLines: [], regionLines: [], postalCode: null, note: null };
  }
  return {
    source: 'live',
    notice: RECIPIENT_NOTICE.live,
    name: present(address.recipientName) ? address.recipientName : '—',
    phone: present(address.phone) ? address.phone : null,
    addressLines: [[address.addressDetail, address.fullAddress].find(present)].filter(present),
    regionLines: regionLinesOf({
      village: address.village?.name, district: address.district?.name, city: address.city?.name, province: address.province?.name,
    }),
    postalCode: [address.postalCode, address.village?.postalCode].find(present) ?? null,
    note: present(address.notes) ? address.notes : null,
  };
}

export function toPrintResiView(order: PrintResiOrderInput): PrintResiView {
  const courier = resiCourier(order.shipment?.provider ?? order.shippingProvider);
  const rawProvider = order.shipment?.provider ?? order.shippingProvider;
  const serviceName = [order.shippingServiceName, order.shipment?.service, order.shippingService].find(present) ?? null;
  const outlet = [order.outlet?.name, order.reservations?.[0]?.outlet?.name].find(present) ?? '—';

  return {
    orderNumber: order.orderNumber,
    orderDate: formatResiDate(order.createdAt),
    outlet,
    recipient: resolveRecipient(order),
    items: order.items.map((item) => ({
      key: item.id,
      productName: item.productName,
      quantity: item.quantity,
      options: typeof item.spicyLevel === 'number' ? [`Level pedas ${item.spicyLevel}`] : [],
      toppings: (item.toppings ?? []).map((topping) => topping.name).filter(present),
      notes: present(item.notes) ? item.notes : null,
    })),
    shipment: {
      courier,
      courierName: courier ? COURIER_NAME[courier] : present(rawProvider) ? rawProvider.toUpperCase() : '—',
      serviceName,
      awb: persistedAwb(order),
    },
  };
}

/* ------------------------------------------------------------------------------------
 * Fit-to-label planning (pure). The component measures the rendered slip and asks
 * `nextFitStep` what to do until everything fits; the shipping/AWB block always
 * stays on page 1.
 *   1. shrink the middle section's text (RESI_SCALES);
 *   2. at the smallest size, a recipient block that still overflows moves IN FULL to
 *      a continuation page (page 1 keeps name/phone/region and says so);
 *   3. items that still do not fit continue, whole, on the continuation page.
 * Nothing is ever clipped or dropped.
 * ---------------------------------------------------------------------------------- */

export const RESI_SCALES = [1, 0.92, 0.84, 0.76, 0.7] as const;

export interface ResiFitState {
  scaleIndex: number;
  recipientOnContinuation: boolean;
  /** Items kept on page 1; null = all of them. */
  page1Items: number | null;
  done: boolean;
  /** Done but something still overflows page 1 (should not happen; surfaced in the UI). */
  unresolved: boolean;
}

export interface ResiFitMeasurement {
  recipientOverflow: boolean;
  itemsOverflow: boolean;
  /** Items whose box ends inside the visible items area (first split jump). */
  itemsFitting: number;
  totalItems: number;
}

export const INITIAL_FIT: ResiFitState = { scaleIndex: 0, recipientOnContinuation: false, page1Items: null, done: false, unresolved: false };

export function nextFitStep(state: ResiFitState, m: ResiFitMeasurement): ResiFitState {
  if (state.done) return state;
  if (!m.recipientOverflow && !m.itemsOverflow) return { ...state, done: true };
  if (state.scaleIndex < RESI_SCALES.length - 1) return { ...state, scaleIndex: state.scaleIndex + 1 };
  if (m.recipientOverflow && !state.recipientOnContinuation) return { ...state, recipientOnContinuation: true };
  if (m.itemsOverflow) {
    const current = state.page1Items ?? m.totalItems;
    if (current === 0) return { ...state, done: true, unresolved: true };
    // First split: jump to what fits, leaving room for the "continued" line; then step down.
    const next = state.page1Items === null ? Math.min(Math.max(m.itemsFitting - 1, 0), m.totalItems - 1) : current - 1;
    return { ...state, page1Items: Math.max(next, 0) };
  }
  return { ...state, done: true, unresolved: true };
}

/**
 * Physical page and layout constants (mm) shared by the CSS and the tests.
 * The barcode spans the shipping box border-to-border: sheet 100 - 2 x 3 mm safe
 * margin - 2 x 0.35 mm border = 93.3 mm, of which 93 mm is the barcode budget. The
 * box padding is white, so the symbol's own 10-module quiet zones sit inside it.
 */
export const RESI_PAGE = { widthMm: 100, heightMm: 150, safeMarginMm: 3, borderMm: 0.35, barcodeMaxWidthMm: 93, barcodeHeightMm: 13 } as const;
