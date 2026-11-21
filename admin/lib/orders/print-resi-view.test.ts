import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  courierLogoSrc, formatResiDate, INITIAL_FIT, nextFitStep, persistedAwb, PRINT_RESI_BLOCKER_MESSAGE, printResiBlocker,
  PrintResiOrderInput, RECIPIENT_NOTICE, resolveRecipient, RESI_PAGE, RESI_SCALES, ResiFitState, toPrintResiView,
} from './print-resi-view.ts';
import { PRINT_RESI_CSS } from './print-resi-css.ts';
import { barcodeSize, code128Bars, decodeCode128, encodeCode128, modulesFromBars, START_C } from '../barcode/code128.ts';

/**
 * Print Resi (Admin Order Detail, 100 x 150 mm). Pure mapping, barcode and fit planning
 * are tested directly; the React component and the Order Detail wiring are pinned in
 * the source (this package has no component-render harness).
 */

const JNE_AWB = '0291492600000050';
const PAXEL_AWB = 'CO.EMSULAR-20261030-1-CYOCBX';

function order(overrides: Partial<PrintResiOrderInput> = {}): PrintResiOrderInput {
  return {
    orderNumber: 'BMS-20261030-R3D1QGSE',
    createdAt: '2026-10-30T04:39:00.000Z',
    shippingProvider: 'jne',
    shippingService: 'REG23',
    shippingServiceName: 'JNE Reguler',
    trackingNumber: JNE_AWB,
    outlet: { name: 'Bakso Mas Sular' },
    reservations: [],
    address: {
      recipientName: 'Siti Aminah',
      phone: '081234567890',
      fullAddress: 'Jl. Melati No. 5, Bandung',
      notes: 'Pagar hijau',
      addressDetail: 'Jl. Melati No. 5 RT 02/RW 03',
      postalCode: '40287',
      province: { name: 'Jawa Barat' },
      city: { name: 'Kabupaten Bandung' },
      district: { name: 'Bojongsoang' },
      village: { name: 'Lengkong', postalCode: '40287' },
    },
    items: [{ id: 'i1', productName: 'Bakso Urat Frozen', quantity: 2, spicyLevel: null, notes: null, toppings: [] }],
    shipment: { provider: 'jne', service: 'REG', trackingNumber: JNE_AWB },
    ...overrides,
  };
}

/** Decode exactly what the SVG draws: bars -> modules -> text. */
function decodeDrawn(value: string): string | null {
  const enc = encodeCode128(value);
  assert.ok(enc, value);
  return decodeCode128(modulesFromBars(code128Bars(enc.modules), enc.totalModules));
}

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const COMPONENT = read('components/orders/print-resi.tsx');
const DETAIL = read('app/orders/[id]/page.tsx');

test('JNE with a valid numeric AWB: printable, JNE logo, exact AWB, set-C barcode that decodes to it', () => {
  const o = order();
  assert.equal(printResiBlocker(o), null);
  const view = toPrintResiView(o);
  assert.equal(view.shipment.courier, 'jne');
  assert.equal(view.shipment.courierName, 'JNE');
  assert.equal(view.shipment.awb, JNE_AWB);
  assert.equal(courierLogoSrc(view.shipment.courier), '/print/jne-logo.jpg');
  const enc = encodeCode128(JNE_AWB);
  assert.ok(enc);
  assert.equal(enc.symbols[0], START_C, 'all-digit AWB starts in set C');
  assert.equal(decodeDrawn(JNE_AWB), JNE_AWB);
  const size = barcodeSize(enc.totalModules, RESI_PAGE.barcodeMaxWidthMm);
  assert.deepEqual(size, { moduleMm: 0.5, widthMm: 71.5, snapped: true, meetsMinimum: true });
});

test('Paxel with an alphanumeric AWB (dots, dashes, letters): exact, decodes, fits the label at whole-dot bars', () => {
  const o = order({ shippingProvider: 'paxel', trackingNumber: PAXEL_AWB, shipment: { provider: 'paxel', service: 'Paxel Regular', trackingNumber: PAXEL_AWB } });
  assert.equal(printResiBlocker(o), null);
  const view = toPrintResiView(o);
  assert.equal(view.shipment.courier, 'paxel');
  assert.equal(view.shipment.courierName, 'Paxel');
  assert.equal(view.shipment.awb, PAXEL_AWB);
  assert.equal(courierLogoSrc('paxel'), '/print/paxel-logo.jpeg');
  assert.equal(decodeDrawn(PAXEL_AWB), PAXEL_AWB);
  const enc = encodeCode128(PAXEL_AWB);
  assert.ok(enc);
  const size = barcodeSize(enc.totalModules, RESI_PAGE.barcodeMaxWidthMm);
  assert.equal(size.snapped, true);
  assert.equal(size.moduleMm, 0.25);
  assert.ok(size.widthMm <= RESI_PAGE.barcodeMaxWidthMm);
});

test('missing AWB: not printable, clear message, no fake value (never the order number)', () => {
  for (const tracking of [null, undefined, '', '   ']) {
    const o = order({ trackingNumber: tracking, shipment: { provider: 'jne', service: 'REG', trackingNumber: tracking } });
    assert.equal(printResiBlocker(o), 'awb-missing');
    assert.equal(persistedAwb(o), null);
    assert.equal(toPrintResiView(o).shipment.awb, null);
  }
  const noShipment = order({ shipment: null, trackingNumber: null });
  assert.equal(printResiBlocker(noShipment), 'awb-missing');
  assert.match(PRINT_RESI_BLOCKER_MESSAGE['awb-missing'], /Resi belum bisa dicetak: nomor Resi\/AWB belum tersedia/);
  // An AWB a barcode cannot carry exactly is refused rather than altered.
  assert.equal(printResiBlocker(order({ shipment: { provider: 'jne', service: 'REG', trackingNumber: `AWB${String.fromCharCode(0xc5)}1` } })), 'awb-unencodable');
  // Shipment.trackingNumber wins over the Order mirror; the mirror is a fallback only.
  assert.equal(persistedAwb({ shipment: { provider: 'jne', service: 'REG', trackingNumber: 'A1' }, trackingNumber: 'B2' }), 'A1');
  assert.equal(persistedAwb({ shipment: { provider: 'jne', service: 'REG', trackingNumber: null }, trackingNumber: 'B2' }), 'B2');
  // The component gates on the blocker: disabled button + message, and no sheet is ever mounted.
  assert.match(COMPONENT, /disabled=\{blocker !== null\}/);
  assert.match(COMPONENT, /PRINT_RESI_BLOCKER_MESSAGE\[blocker\]/);
  assert.match(COMPONENT, /job > 0 && blocker === null && typeof document !== 'undefined'/);
});

test('missing optional recipient fields render as absent, not as placeholders or crashes', () => {
  const view = toPrintResiView(
    order({
      address: { recipientName: 'Budi', phone: '', fullAddress: 'Jl. Lama 1', notes: null, addressDetail: null, postalCode: null, province: null, city: null, district: null, village: null },
    }),
  );
  assert.deepEqual(view.recipient, {
    source: 'live', notice: RECIPIENT_NOTICE.live, name: 'Budi', phone: null, addressLines: ['Jl. Lama 1'], regionLines: [], postalCode: null, note: null,
  });
  // Region lines only for present parts; village postal code is the fallback.
  const partial = toPrintResiView(order({ address: { ...order().address!, district: null, postalCode: null, province: { name: ' ' } } }));
  assert.deepEqual(partial.recipient.regionLines, ['Kel. Lengkong', 'Kabupaten Bandung']);
  assert.equal(partial.recipient.postalCode, '40287');
  assert.equal(printResiBlocker(order({ address: null })), 'no-address');
});

test('long address: kept in full (no truncation), wraps anywhere, and the fit plan never clips', () => {
  const long = 'Perumahan Griya Bukit Indah Blok ZZ-99 No. 123 '.repeat(20).trim();
  const view = toPrintResiView(order({ address: { ...order().address!, addressDetail: long } }));
  assert.deepEqual(view.recipient.addressLines, [long]);
  assert.match(PRINT_RESI_CSS, /\.resi-wrap \{ overflow-wrap: anywhere; word-break: break-word;/);
  // Shrink through every scale, then move the recipient to the continuation page.
  let state: ResiFitState = INITIAL_FIT;
  const overflowing = { recipientOverflow: true, itemsOverflow: false, itemsFitting: 1, totalItems: 1 };
  for (let i = 1; i < RESI_SCALES.length; i += 1) {
    state = nextFitStep(state, overflowing);
    assert.equal(state.scaleIndex, i);
  }
  state = nextFitStep(state, overflowing);
  assert.equal(state.recipientOnContinuation, true);
  state = nextFitStep(state, { ...overflowing, recipientOverflow: false });
  assert.deepEqual(state, { scaleIndex: RESI_SCALES.length - 1, recipientOnContinuation: true, page1Items: null, done: true, unresolved: false });
  assert.match(COMPONENT, /Alamat lengkap: lihat halaman 2\./);
});

test('multiple items: order kept, each line has qty + name; overflow continues on page 2, whole items only', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, productName: `Produk ${i + 1}`, quantity: i + 1, toppings: [] }));
  const view = toPrintResiView(order({ items }));
  assert.deepEqual(view.items.map((i) => [i.key, i.productName, i.quantity]), items.map((i) => [i.id, i.productName, i.quantity]));
  let state: ResiFitState = { ...INITIAL_FIT, scaleIndex: RESI_SCALES.length - 1 };
  state = nextFitStep(state, { recipientOverflow: false, itemsOverflow: true, itemsFitting: 7, totalItems: 12 });
  assert.equal(state.page1Items, 6, 'first split leaves a line for the "continued" note');
  state = nextFitStep(state, { recipientOverflow: false, itemsOverflow: true, itemsFitting: 6, totalItems: 12 });
  assert.equal(state.page1Items, 5);
  state = nextFitStep(state, { recipientOverflow: false, itemsOverflow: false, itemsFitting: 5, totalItems: 12 });
  assert.equal(state.done, true);
  assert.equal(state.unresolved, false);
  assert.match(COMPONENT, /view\.items\.slice\(0, page1Count\)/);
  assert.match(COMPONENT, /view\.items\.slice\(page1Count\)/);
  assert.match(COMPONENT, /Berlanjut di halaman 2/);
  // The fit loop always terminates.
  let s: ResiFitState = INITIAL_FIT;
  for (let i = 0; i < 50 && !s.done; i += 1) s = nextFitStep(s, { recipientOverflow: true, itemsOverflow: true, itemsFitting: 0, totalItems: 3 });
  assert.equal(s.done, true);
  assert.equal(s.unresolved, true);
});

test('variants and add-ons: spicy level (0 included) and topping names, never prices', () => {
  const view = toPrintResiView(
    order({
      items: [
        { id: 'a', productName: 'Bakso Mercon', quantity: 1, spicyLevel: 3, toppings: [{ name: 'Tetelan' }, { name: 'Bakso Telur' }] },
        { id: 'b', productName: 'Bakso Halus', quantity: 2, spicyLevel: 0, toppings: [] },
      ],
    }),
  );
  assert.deepEqual(view.items[0].options, ['Level pedas 3']);
  assert.deepEqual(view.items[0].toppings, ['Tetelan', 'Bakso Telur']);
  assert.deepEqual(view.items[1].options, ['Level pedas 0']);
  assert.equal(/price|\bRp|formatRupiah|rupiah/i.test(COMPONENT), false, 'no financial details on the slip');
});

test('item notes are carried and printed', () => {
  const view = toPrintResiView(order({ items: [{ id: 'n', productName: 'Bakso', quantity: 1, notes: 'Kuah dipisah', toppings: [] }, { id: 'm', productName: 'Mie', quantity: 1, notes: '  ', toppings: [] }] }));
  assert.equal(view.items[0].notes, 'Kuah dipisah');
  assert.equal(view.items[1].notes, null);
  assert.match(COMPONENT, /Catatan: \{item\.notes\}/);
});

test('courier logo selection is by provider id only; unknown couriers print their name, no logo', () => {
  assert.equal(courierLogoSrc(toPrintResiView(order({ shipment: { provider: 'JNE', service: 'x', trackingNumber: '1' } })).shipment.courier), '/print/jne-logo.jpg');
  assert.equal(courierLogoSrc(toPrintResiView(order({ shipment: { provider: 'paxel', service: 'x', trackingNumber: '1' } })).shipment.courier), '/print/paxel-logo.jpeg');
  const other = toPrintResiView(order({ shipment: { provider: 'sicepat', service: 'x', trackingNumber: '1' } }));
  assert.equal(other.shipment.courier, null);
  assert.equal(other.shipment.courierName, 'SICEPAT');
  assert.equal(courierLogoSrc(null), null);
  // No shipment row yet: the checkout snapshot names the courier.
  assert.equal(toPrintResiView(order({ shipment: null, shippingProvider: 'paxel' })).shipment.courier, 'paxel');
  for (const asset of ['public/print/jne-logo.jpg', 'public/print/paxel-logo.jpeg', 'public/print/mas-sular-logo.png']) {
    assert.ok(readFileSync(join(process.cwd(), asset)).length > 1000, asset);
  }
});

test('barcode encodes the EXACT AWB — decoded from the drawn bars — and the slip feeds it the AWB, not the order number', () => {
  for (const awb of [JNE_AWB, PAXEL_AWB, '1', '12', '123', 'A1234', 'A123456B', '000000', 'awb 12/34.x_y-Z']) {
    assert.equal(decodeDrawn(awb), awb);
  }
  assert.notEqual(decodeDrawn(JNE_AWB), 'BMS-20261030-R3D1QGSE');
  assert.match(COMPONENT, /const awb = view\.shipment\.awb \?\? '';/);
  assert.match(COMPONENT, /<Code128Barcode value=\{awb\}/);
  assert.equal(/Code128Barcode value=\{view\.orderNumber/.test(COMPONENT), false);
});

test('print view excludes admin nav, buttons and every other page content', () => {
  const print = PRINT_RESI_CSS.slice(PRINT_RESI_CSS.indexOf('@media print'));
  assert.match(print, /body > \*:not\(\.print-resi-root\) \{ display: none !important; \}/);
  assert.match(print, /\.print-resi-root \{ position: static !important; left: auto !important; visibility: visible !important;/);
  // On screen the sheet is off-canvas and hidden.
  assert.match(PRINT_RESI_CSS, /\.print-resi-root \{ position: fixed; top: 0; left: -1000mm; visibility: hidden;/);
  // The sheet is portalled to <body> (a direct child, so the rule above isolates it) and holds no controls.
  assert.match(COMPONENT, /createPortal\(<PrintResiDocument key=\{job\} view=\{view\} onReady=\{print\} \/>, document\.body\)/);
  const sheets = COMPONENT.slice(COMPONENT.indexOf('export function PrintResiSheets'));
  assert.equal(/<button|<a |<Link/.test(sheets), false);
});

test('print size: exactly 100 x 150 mm, margin 0 (no browser header/footer box), single first sheet', () => {
  assert.match(PRINT_RESI_CSS, /@page \{ size: 100mm 150mm; margin: 0; \}/);
  assert.match(PRINT_RESI_CSS, /width: 100mm; height: 149\.5mm; padding: 3mm; overflow: hidden;/);
  assert.match(PRINT_RESI_CSS, /\.resi-sheet:last-child \{ break-after: auto; page-break-after: auto; \}/);
  assert.deepEqual({ w: RESI_PAGE.widthMm, h: RESI_PAGE.heightMm }, { w: 100, h: 150 });
  // The barcode width budget fits inside the sheet's safe area and box padding.
  assert.ok(RESI_PAGE.barcodeMaxWidthMm <= RESI_PAGE.widthMm - 2 * RESI_PAGE.safeMarginMm - 2 * RESI_PAGE.borderMm);
  assert.match(PRINT_RESI_CSS, /\.resi-ship \{ flex: none; padding-left: 0; padding-right: 0; \}/);
  // The @page rule only exists while a print job is mounted (it ships inside the portal).
  assert.match(COMPONENT, /<style>\{PRINT_RESI_CSS\}<\/style>/);
});

test('printing does not mutate: no request, mutation or booking from the action; only window.print()', () => {
  for (const forbidden of [/useMutation/, /useQuery/, /fetch\(/, /from '@\/lib\/admin'/, /api\(/, /retryShipment|prepareShipment|createShipment|updateAdmin|updateShipment/, /localStorage|sessionStorage/]) {
    assert.equal(forbidden.test(COMPONENT), false, String(forbidden));
  }
  assert.equal((COMPONENT.match(/window\.print\(\)/g) ?? []).length, 1);
  // The mapper does not mutate its input.
  const o = order({ items: [{ id: 'z', productName: 'Bakso', quantity: 1, toppings: [{ name: 'Tetelan' }] }] });
  const before = JSON.stringify(o);
  toPrintResiView(o);
  printResiBlocker(o);
  assert.equal(JSON.stringify(o), before);
  // Order Detail renders it from the order the page already loaded (no second fetch).
  assert.match(DETAIL, /<PrintResiAction order=\{order\} \/>/);
  assert.equal(/window\.print\(/.test(DETAIL), false);
});

test('header: Nomer Order, Tanggal in Asia/Jakarta, outlet with reservation fallback', () => {
  assert.equal(formatResiDate('2026-10-30T04:39:00.000Z'), '30 Oktober 2026, 11:39 WIB');
  assert.equal(formatResiDate('2026-12-31T17:05:00.000Z'), '1 Januari 2027, 00:05 WIB');
  assert.equal(formatResiDate('nope'), '—');
  assert.equal(toPrintResiView(order()).outlet, 'Bakso Mas Sular');
  assert.equal(toPrintResiView(order({ outlet: null, reservations: [{ outlet: { name: 'Outlet Buah Batu' } }] })).outlet, 'Outlet Buah Batu');
  assert.equal(toPrintResiView(order({ outlet: null, reservations: [] })).outlet, '—');
  for (const text of ['PACKING SLIP', 'Nomer Order', 'Tanggal', 'Outlet', 'PENERIMA', 'DAFTAR PESANAN', 'PENGIRIMAN', 'Resi / AWB']) {
    assert.ok(COMPONENT.includes(text), text);
  }
});

/* ---------------- Address source priority (immutable snapshots) ---------------- */

const ORDER_SNAPSHOT = {
  version: 1, recipientName: 'Siti (checkout)', phone: '081111111111', addressDetail: 'Jl. Kenanga No. 7 Blok F Perumahan Griya Indah Permai',
  fullAddress: 'Jl. Kenanga No. 7', village: 'Cipagalo', district: 'Bojongsoang', city: 'Kabupaten Bandung', province: 'Jawa Barat', postalCode: '40287', note: 'Rumah cat biru',
};
const PAXEL_SNAPSHOT = {
  version: 1, provider: 'paxel', capturedAt: '2026-10-30T05:00:00.000Z', recipientName: 'Siti (paxel)', phone: '082222222222',
  addressLines: ['Jl. Kenanga No. 7 Blok F Perumahan Griya Indah Permai'], village: 'Cipagalo', district: 'Bojongsoang', city: 'Kabupaten Bandung',
  province: 'Jawa Barat', postalCode: '40287', note: 'Rumah cat biru', addressTruncated: false, coordinatesSubmitted: true,
  providerFields: { name: 'Siti (paxel)' },
};
const JNE_SNAPSHOT = {
  version: 1, provider: 'jne', capturedAt: '2026-10-30T05:00:00.000Z', recipientName: 'Siti (jne)', phone: '083333333333',
  addressLines: ['Jl. Kenanga No. 7 Blok F Peruma', 'Kel. Cipagalo, Kec. Bojongsoang'], village: null, district: null, city: 'Kabupaten Bandung',
  province: 'Jawa Barat', postalCode: '40287', note: null, addressTruncated: true, providerFields: { RECEIVER_ADDR1: 'Jl. Kenanga No. 7 Blok F Peruma' },
};

test('source priority: the shipment destination snapshot wins over the order snapshot and the live address', () => {
  const r = resolveRecipient(order({ recipientSnapshot: ORDER_SNAPSHOT, shipment: { provider: 'paxel', service: 'x', trackingNumber: PAXEL_AWB, destinationSnapshot: PAXEL_SNAPSHOT } }));
  assert.equal(r.source, 'shipment');
  assert.equal(r.notice, null);
  assert.equal(r.name, 'Siti (paxel)');
  assert.equal(r.phone, '082222222222');
  assert.deepEqual(r.addressLines, ['Jl. Kenanga No. 7 Blok F Perumahan Griya Indah Permai']);
  assert.deepEqual(r.regionLines, ['Kel. Cipagalo', 'Kec. Bojongsoang', 'Kabupaten Bandung', 'Jawa Barat']);
  assert.equal(r.note, 'Rumah cat biru');
});

test('a JNE snapshot the courier shortened is never shown as the complete address', () => {
  // With the checkout snapshot: full street/region lines from checkout, submitted name/phone/zip, and a notice.
  const withCheckout = resolveRecipient(order({ recipientSnapshot: ORDER_SNAPSHOT, shipment: { provider: 'jne', service: 'REG', trackingNumber: JNE_AWB, destinationSnapshot: JNE_SNAPSHOT } }));
  assert.equal(withCheckout.source, 'shipment');
  assert.equal(withCheckout.notice, RECIPIENT_NOTICE.truncatedWithCheckout);
  assert.equal(withCheckout.name, 'Siti (jne)');
  assert.deepEqual(withCheckout.addressLines, [ORDER_SNAPSHOT.addressDetail]);
  assert.deepEqual(withCheckout.regionLines, ['Kel. Cipagalo', 'Kec. Bojongsoang', 'Kabupaten Bandung', 'Jawa Barat']);
  // Without it: the submitted (shortened) lines, labelled as shortened and incomplete.
  const alone = resolveRecipient(order({ recipientSnapshot: null, shipment: { provider: 'jne', service: 'REG', trackingNumber: JNE_AWB, destinationSnapshot: JNE_SNAPSHOT } }));
  assert.equal(alone.notice, RECIPIENT_NOTICE.truncated);
  assert.deepEqual(alone.addressLines, JNE_SNAPSHOT.addressLines);
  // Wording: the checkout case names its source and denies being the courier's copy;
  // the shortened case says it is incomplete and does not blame the courier for the cut.
  assert.match(RECIPIENT_NOTICE.truncatedWithCheckout, /sesuai checkout/);
  assert.match(RECIPIENT_NOTICE.truncatedWithCheckout, /tidak sama persis/);
  assert.match(RECIPIENT_NOTICE.truncated, /dikirim ke kurir, sudah disingkat/);
  assert.match(RECIPIENT_NOTICE.truncated, /tidak lengkap/);
  assert.doesNotMatch(RECIPIENT_NOTICE.truncated, /kurir menyingkat/);
  // A snapshot that was NOT shortened carries no notice: it is exactly what was submitted.
  const intact = resolveRecipient(order({ recipientSnapshot: ORDER_SNAPSHOT, shipment: { provider: 'jne', service: 'REG', trackingNumber: JNE_AWB, destinationSnapshot: { ...JNE_SNAPSHOT, addressTruncated: false } } }));
  assert.equal(intact.notice, null);
  assert.deepEqual(intact.addressLines, JNE_SNAPSHOT.addressLines);
});

test('the order recipient snapshot is the fallback before booking, and ignores later edits to the live address', () => {
  const edited = { ...order().address!, recipientName: 'Nama BARU', addressDetail: 'Alamat BARU setelah checkout' };
  const r = resolveRecipient(order({ address: edited, recipientSnapshot: ORDER_SNAPSHOT, shipment: { provider: 'jne', service: 'REG', trackingNumber: JNE_AWB, destinationSnapshot: null } }));
  assert.equal(r.source, 'order');
  assert.equal(r.notice, null);
  assert.equal(r.name, 'Siti (checkout)');
  assert.deepEqual(r.addressLines, [ORDER_SNAPSHOT.addressDetail]);
  assert.equal(r.postalCode, '40287');
  // Legacy free-text snapshot (no addressDetail) falls back to fullAddress.
  assert.deepEqual(resolveRecipient(order({ recipientSnapshot: { ...ORDER_SNAPSHOT, addressDetail: null } })).addressLines, ['Jl. Kenanga No. 7']);
});

test('legacy orders (no snapshots) use the live address and say so; unknown snapshot versions are ignored', () => {
  const legacy = resolveRecipient(order());
  assert.equal(legacy.source, 'live');
  assert.equal(legacy.notice, RECIPIENT_NOTICE.live);
  assert.match(RECIPIENT_NOTICE.live, /Alamat tersimpan saat ini/);
  for (const bad of [{ version: 2, recipientName: 'x', addressLines: [] }, { recipientName: 'x' }, 'text', 42, []]) {
    assert.equal(resolveRecipient(order({ recipientSnapshot: bad, shipment: { provider: 'jne', service: 'x', trackingNumber: '1', destinationSnapshot: bad } })).source, 'live');
  }
  // No snapshot and no address at all: not printable.
  assert.equal(printResiBlocker(order({ address: null, recipientSnapshot: null })), 'no-address');
  assert.equal(printResiBlocker(order({ address: null, recipientSnapshot: ORDER_SNAPSHOT })), null);
  assert.match(COMPONENT, /\{r\.notice \? <p className="resi-source" data-recipient-source=\{r\.source\}>\{r\.notice\}<\/p> : null\}/);
});

/* ---------------- Barcode width fixtures (100 mm label, 203 dpi, 0.25 mm minimum) ---------------- */

const BARCODE_FIXTURES: Array<{ name: string; awb: string; modules: number; moduleMm: number; widthMm: number; meetsMinimum: boolean }> = [
  { name: 'Paxel sequence 1', awb: 'CO.EMSULAR-20261030-1-CYOCBX', modules: 341, moduleMm: 0.25, widthMm: 85.25, meetsMinimum: true },
  { name: 'Paxel sequence 9', awb: 'CO.EMSULAR-20261030-9-CYOCBX', modules: 341, moduleMm: 0.25, widthMm: 85.25, meetsMinimum: true },
  { name: 'Paxel sequence 10', awb: 'CO.EMSULAR-20261030-10-CYOCBX', modules: 352, moduleMm: 0.25, widthMm: 88, meetsMinimum: true },
  { name: 'Paxel sequence 99', awb: 'CO.EMSULAR-20261030-99-CYOCBX', modules: 352, moduleMm: 0.25, widthMm: 88, meetsMinimum: true },
  { name: 'Paxel sequence 100', awb: 'CO.EMSULAR-20261030-100-CYOCBX', modules: 363, moduleMm: 0.25, widthMm: 90.75, meetsMinimum: true },
  { name: 'long alphanumeric AWB', awb: 'CO.EMSULARPROD-20261231-1234-CYOCBXQZ', modules: 440, moduleMm: 93 / 440, widthMm: 93, meetsMinimum: false },
  { name: 'JNE 15-digit', awb: '010116260018481', modules: 154, moduleMm: 0.5, widthMm: 77, meetsMinimum: true },
  { name: 'JNE 16-digit', awb: '0291492600000050', modules: 143, moduleMm: 0.5, widthMm: 71.5, meetsMinimum: true },
];

test('barcode fixtures: dimensions, printer constraints and exact decode for every AWB shape', () => {
  for (const f of BARCODE_FIXTURES) {
    const enc = encodeCode128(f.awb);
    assert.ok(enc, f.name);
    assert.equal(enc.totalModules, f.modules, `${f.name}: modules`);
    const size = barcodeSize(enc.totalModules, RESI_PAGE.barcodeMaxWidthMm);
    assert.ok(Math.abs(size.moduleMm - f.moduleMm) < 1e-9, `${f.name}: module ${size.moduleMm}`);
    assert.ok(Math.abs(size.widthMm - f.widthMm) < 1e-9, `${f.name}: width ${size.widthMm}`);
    assert.equal(size.meetsMinimum, f.meetsMinimum, `${f.name}: >= 0.25 mm`);
    assert.equal(size.snapped, f.meetsMinimum, `${f.name}: whole 203-dpi dots`);
    assert.ok(size.widthMm <= RESI_PAGE.barcodeMaxWidthMm, `${f.name}: inside the label`);
    assert.equal(decodeDrawn(f.awb), f.awb, `${f.name}: decodes exactly`);
  }
  // The largest symbol that still meets 0.25 mm on this label: 372 modules (93 / 0.25).
  assert.equal(barcodeSize(372, RESI_PAGE.barcodeMaxWidthMm).meetsMinimum, true);
  assert.equal(barcodeSize(373, RESI_PAGE.barcodeMaxWidthMm).meetsMinimum, false);
  // Below the minimum is surfaced, never silent.
  assert.match(COMPONENT, /barcodeBelowMinimum \? \(\s*<p role="status"[^>]*>\{BARCODE_BELOW_MINIMUM_MESSAGE\}<\/p>/);
});
