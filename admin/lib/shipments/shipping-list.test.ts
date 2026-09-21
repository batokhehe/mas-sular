import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';

// shipping-list.ts imports './service-display' without an extension (as Next.js
// resolves it); node's test runner does not, so - exactly like
// packing-slip-view.test.ts - a test-local resolve hook tries `<specifier>.ts`.
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
const {
  ACTIVE_SHIPPING_STATUSES,
  EXCLUDED_SHIPPING_STATUSES,
  matchesShipmentSearch,
  SHIPMENT_STATUSES,
  SHIPPING_LIST_SCOPE,
  SHIPPING_STATUS_FILTER_OPTIONS,
} = await import('./shipping-list.ts');

/**
 * Admin → Shipping shows only active / actionable shipments. The server applies the
 * rule (GET /admin/shipments?scope=active; backend admin-shipping-list-scope specs);
 * these pin the admin side: the real status vocabulary, the dropdown, the search and
 * the page wiring (no component-render harness in this package).
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const PAGE = strip(read('app/shipping/page.tsx'));
const API = read('lib/admin.ts');
const BACKEND_RULE = read('../backend/src/modules/admin/shipping-list-scope.ts');

const prismaEnum = (name: string) => {
  const block = read('../backend/prisma/schema.prisma').match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  assert.ok(block, `enum ${name} exists`);
  return block[1].split('\n').map((l) => l.trim()).filter(Boolean);
};

test('the status list IS the backend ShipmentStatus enum (no invented values)', () => {
  assert.deepEqual([...SHIPMENT_STATUSES], prismaEnum('ShipmentStatus'));
  for (const name of ['CANCELED', 'EXPIRED', 'READY_TO_SHIP', 'BOOKED', 'PROCESSING', 'SHIPPED']) {
    assert.equal((SHIPMENT_STATUSES as readonly string[]).includes(name), false, `${name} is not a shipment status`);
  }
});

test('excluded = DELIVERED + CANCELLED, the same statuses the server rule excludes', () => {
  assert.deepEqual([...EXCLUDED_SHIPPING_STATUSES], ['DELIVERED', 'CANCELLED']);
  assert.match(BACKEND_RULE, /SHIPPING_EXCLUDED_SHIPMENT_STATUSES: readonly ShipmentStatus\[\] = \[ShipmentStatus\.DELIVERED, ShipmentStatus\.CANCELLED\]/);
  assert.match(BACKEND_RULE, /SHIPPING_EXCLUDED_ORDER_STATUSES: readonly OrderStatus\[\] = \[OrderStatus\.DELIVERED, OrderStatus\.COMPLETED, OrderStatus\.CANCELLED\]/);
  assert.match(BACKEND_RULE, /export const SHIPPING_LIST_ACTIVE_SCOPE = 'active' as const;/);
  assert.equal(SHIPPING_LIST_SCOPE, 'active');
});

for (const status of ['PENDING', 'RATE_SELECTED', 'CREATED', 'WAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED', 'UNKNOWN']) {
  test(`${status} → visible (active, offered in the status filter)`, () => {
    assert.ok((ACTIVE_SHIPPING_STATUSES as readonly string[]).includes(status));
    assert.ok((SHIPPING_STATUS_FILTER_OPTIONS as readonly string[]).includes(status));
  });
}

for (const status of ['DELIVERED', 'CANCELLED']) {
  test(`${status} → hidden (not active, not offered in the status filter)`, () => {
    assert.equal((ACTIVE_SHIPPING_STATUSES as readonly string[]).includes(status), false);
    assert.equal((SHIPPING_STATUS_FILTER_OPTIONS as readonly string[]).includes(status), false);
  });
}

test('the status filter: "Semua" (all active) first, then every active status, each exactly once', () => {
  assert.deepEqual([...SHIPPING_STATUS_FILTER_OPTIONS], ['ALL', ...ACTIVE_SHIPPING_STATUSES]);
  assert.equal(new Set(SHIPPING_STATUS_FILTER_OPTIONS).size, SHIPPING_STATUS_FILTER_OPTIONS.length);
});

const row = (over: Record<string, unknown> = {}) => ({
  provider: 'paxel',
  service: 'Paxel Same Day',
  trackingNumber: 'PXL-123456',
  order: { orderNumber: 'BMS-20260921-AB12CD34', shippingServiceName: 'Paxel Same Day', shippingService: 'PAXEL_SAMEDAY' },
  ...over,
});

test('search: order number, provider, every service representation and AWB, case-insensitive', () => {
  for (const needle of ['ab12cd34', 'PAXEL', 'same day', 'PAXEL_SAMEDAY', 'pxl-123', '']) {
    assert.equal(matchesShipmentSearch(row(), needle), true, needle);
  }
  assert.equal(matchesShipmentSearch(row(), 'jne'), false);
  assert.equal(matchesShipmentSearch(row({ trackingNumber: null }), 'pxl'), false);
});

test('search + status: search narrows the (already active-only) page the server returned', () => {
  const page = [
    row(),
    row({ provider: 'jne', service: 'REG', trackingNumber: 'JNE0001', order: { orderNumber: 'BMS-20260921-ZZ99ZZ99', shippingServiceName: 'JNE REG', shippingService: 'REG' } }),
  ];
  assert.deepEqual(page.filter((s) => matchesShipmentSearch(s, 'jne')).map((s) => s.trackingNumber), ['JNE0001']);
  assert.deepEqual(page.filter((s) => matchesShipmentSearch(s, 'no-such-order')), []);
});

test('page: asks the server for the active scope, so paging and totals match what is shown', () => {
  assert.match(PAGE, /fetchAdminShipments\(\{ scope: SHIPPING_LIST_SCOPE, status: statusFilter === 'ALL' \? undefined : statusFilter, page, limit \}\)/);
  assert.match(PAGE, /queryKey: \['admin-shipments', SHIPPING_LIST_SCOPE, statusFilter, page, limit\]/);
  assert.match(API, /if \(params\.scope\) q\.set\('scope', params\.scope\);/);
  // Pagination still comes from the server envelope; changing status/limit resets to page 1.
  assert.match(PAGE, /<Pagination\s+page=\{data\.page\}\s+limit=\{data\.limit\}\s+total=\{data\.total\}\s+totalPages=\{data\.totalPages\}/);
  assert.match(PAGE, /setStatusFilter\(event\.target\.value as ShippingStatusFilter\);\s*setPage\(1\);/);
});

test('page: one source for the rule - no status strings typed into the page', () => {
  assert.match(PAGE, /\{SHIPPING_STATUS_FILTER_OPTIONS\.map\(\(status\) => \(/);
  assert.equal(/const statusOptions =/.test(PAGE), false);
  assert.equal(/'(PENDING|RATE_SELECTED|PICKED_UP|IN_TRANSIT|FAILED|CANCELLED)'/.test(PAGE), false);
  assert.match(PAGE, /data\.items\.filter\(\(shipment: AdminShipment\) => matchesShipmentSearch\(shipment, search\)\)/);
});

test('page: badges, detail links and the empty state are unchanged', () => {
  assert.match(PAGE, /<Badge tone=\{shipment\.status === 'DELIVERED' \? 'success' : 'brand'\}>\{shipmentStatusLabel\(shipment\.status\)\}<\/Badge>/);
  assert.match(PAGE, /<Link href=\{`\/shipping\/\$\{shipment\.id\}`\}/);
  assert.match(PAGE, /shipments\.length === 0 \? \(\s*<p className="p-6 text-sm text-gray-500">Tidak ada pengiriman yang cocok dengan filter\.<\/p>/);
});

test('nothing else in the admin uses the active scope (other menus and dashboards unaffected)', () => {
  const users = ['app/shipping/page.tsx'];
  for (const file of ['app/orders/page.tsx', 'app/dashboard/page.tsx', 'app/orders/[id]/page.tsx', 'app/shipping/[id]/page.tsx', 'app/shipping/new/page.tsx']) {
    assert.equal(/SHIPPING_LIST_SCOPE|scope: 'active'/.test(read(file)), false, file);
  }
  assert.ok(users.every((f) => /SHIPPING_LIST_SCOPE/.test(read(f))));
});
