import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';

// packing-slip-view.ts imports '../barcode/code128' without an extension (as Next.js
// resolves it); node's test runner does not, so - exactly like post-login-access.test.ts -
// a minimal test-local resolve hook tries `<specifier>.ts` for relative imports.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.{1,2}\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return await next(specifier + '.ts', context); } catch {}
  }
  return next(specifier, context);
}`),
  import.meta.url,
);
const { barcodeValue, PACKING_SLIP_ERROR_MESSAGE, packingSlipErrorKind, packingSlipPath } = await import('./packing-slip-view.ts');

/**
 * P3 Packing Slip (Admin). Pure helpers are tested directly; the page, the button
 * and the shell variant are pinned in the source (no component-render harness in
 * this package). The backend mapping, fallbacks, 403/404 and read-only behaviour
 * are proven in backend packing-slip.spec / packing-slip.int-spec.
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const DETAIL = read('app/orders/[id]/page.tsx');
const SLIP = read('app/orders/[id]/packing-slip/page.tsx');
const SHELL = read('components/layout/admin-shell.tsx');
const BARCODE = read('components/orders/code128-barcode.tsx');
const API = read('lib/admin.ts');

test('barcode only for a real, exactly encodable AWB', () => {
  assert.equal(barcodeValue({ trackingNumber: 'PXL-0123456789' }), 'PXL-0123456789');
  assert.equal(barcodeValue({ trackingNumber: '0109401600067399' }), '0109401600067399');
  assert.equal(barcodeValue({ trackingNumber: null }), null);
  assert.equal(barcodeValue({ trackingNumber: '' }), null);
  assert.equal(barcodeValue({ trackingNumber: `AWB${String.fromCharCode(10)}1` }), null);
  assert.equal(barcodeValue({ trackingNumber: `${String.fromCharCode(0xc5)}WB1` }), null);
});

test('error kinds and messages: 403, 404, anything else with retry', () => {
  assert.equal(packingSlipErrorKind(Object.assign(new Error('x'), { status: 403 })), 'forbidden');
  assert.equal(packingSlipErrorKind(Object.assign(new Error('x'), { status: 404 })), 'not-found');
  assert.equal(packingSlipErrorKind(Object.assign(new Error('x'), { status: 500 })), 'other');
  assert.equal(packingSlipErrorKind(new TypeError('Failed to fetch')), 'other');
  assert.equal(PACKING_SLIP_ERROR_MESSAGE.other, 'Tidak dapat memuat packing slip');
});

test('route path', () => {
  assert.equal(packingSlipPath('0f1e-22'), '/orders/0f1e-22/packing-slip');
});

test('Order Detail: the old whole-page window.print() action is gone; "Packing Slip" lives in Order Summary', () => {
  assert.equal(/window\.print\(/.test(DETAIL), false);
  assert.equal(/Print Packing Slip/.test(DETAIL), false);
  const summary = DETAIL.split('<Section title="Order Summary"')[1]?.split('</Section>')[0] ?? '';
  assert.match(summary, /<ActionButton icon=\{Printer\} onClick=\{\(\) => window\.open\(packingSlipPath\(order\.id\), '_blank', 'noopener,noreferrer'\)\}>Packing Slip<\/ActionButton>/);
  const quick = DETAIL.split('<CardTitle>Quick Actions</CardTitle>')[1]?.split('</Card>')[0] ?? '';
  assert.equal(/Packing Slip/.test(quick), false);
});

test('API client: authenticated api() GET of the dedicated endpoint', () => {
  assert.match(API, /return api<PackingSlipView>\(`\/admin\/orders\/\$\{encodeURIComponent\(orderId\)\}\/packing-slip`\);/);
});

test('document page: Order.read, no admin chrome, loading/error/retry, print button hidden in print', () => {
  assert.match(SLIP, /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.orders\} variant="document">/);
  assert.match(SLIP, /queryFn: \(\) => fetchPackingSlip\(orderId\)/);
  assert.match(SLIP, /<SlipSkeleton \/>/);
  assert.match(SLIP, /<SlipError error=\{query\.error\} onRetry=/);
  assert.match(SLIP, /kind === 'other' \? \(/);
  assert.match(SLIP, /className="mx-auto mb-4 flex max-w-\[210mm\] justify-end print:hidden"/);
  assert.match(SLIP, /onClick=\{\(\) => window\.print\(\)\}/);
  assert.match(SLIP, /Cetak \/ Simpan PDF/);
  assert.equal(/Sidebar|Topbar/.test(SLIP), false);
});

test('document layout: branding, heading, sections, columns, toppings without prices', () => {
  for (const text of ['>BMS<', 'Bakso Mas Sular', 'PACKING SLIP', 'Nomor Order', 'Tanggal', 'Outlet', 'PENERIMA', 'Nama', 'Alamat', 'Kode pos', 'No. WA', 'DAFTAR PESANAN', 'No.', 'Nama Produk', 'Qty', 'PENGIRIMAN', 'Resi / AWB', 'Status']) {
    assert.ok(SLIP.includes(text), text);
  }
  assert.match(SLIP, /slip\.recipient\.regionLines\.map/);
  assert.match(SLIP, /item\.toppings\.map\(\(topping\) => \(\s*<li key=\{topping\} className="break-words">\+ \{topping\}<\/li>/);
  assert.equal(/price|Rp|formatRupiah/i.test(SLIP), false, 'no prices');
  assert.equal(/placeholder-logo/.test(SLIP), false);
});

test('print CSS: A4 portrait ~12mm, repeated table header, rows kept together, wrapping', () => {
  assert.match(SLIP, /@page \{ size: A4 portrait; margin: 12mm; \}/);
  assert.match(SLIP, /\.packing-slip thead \{ display: table-header-group; \}/);
  assert.match(SLIP, /\.packing-slip tr, \.packing-slip \.avoid-break \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(SLIP, /break-words/);
  assert.match(SLIP, /break-all font-mono/);
});

test('barcode: fed exactly the tracking number, only when available; SVG, never rasterized', () => {
  assert.match(SLIP, /const barcode = barcodeValue\(slip\.shipment\);/);
  assert.match(SLIP, /\{barcode \? \(\s*<div className="w-\[90mm\] max-w-full justify-self-end text-center">\s*<Code128Barcode value=\{barcode\}/);
  assert.match(SLIP, /<p className="mt-1 break-all font-mono text-sm tracking-wider">\{barcode\}<\/p>/);
  assert.match(SLIP, /value=\{slip\.shipment\.awbLabel\}/);
  assert.match(BARCODE, /<svg/);
  assert.match(BARCODE, /const encoding = encodeCode128B\(value\);\s*if \(!encoding\) return null;/);
  assert.equal(/canvas|toDataURL/.test(BARCODE), false);
});

test('AdminShell document variant: same session + permission checks, no chrome', () => {
  assert.match(SHELL, /variant = 'default'/);
  const start = SHELL.indexOf("if (variant === 'document') {");
  assert.ok(start > 0);
  const doc = SHELL.slice(start, SHELL.indexOf('return <>{children}</>;', start));
  assert.match(doc, /hasAllPermissions\(permissions, requiredPermissions\)/);
  assert.equal(/<Sidebar|<Topbar/.test(doc), false);
  // The session/login checks run before the variant branch.
  assert.ok(SHELL.indexOf("router.replace('/login')") < start);
  assert.ok(SHELL.indexOf('profileQuery.isError') < start);
});
