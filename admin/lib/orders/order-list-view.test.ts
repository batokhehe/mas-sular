import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  courierLabel,
  ORDER_STATUS_TONES,
  orderCourier,
  orderStatusBadge,
  PAYMENT_STATUS_TONES,
  paymentStatusBadge,
} from './order-list-view.ts';
import { orderStatusLabel, paymentStatusLabel } from '../status-labels.ts';
import { COURIER_LABELS } from '../promos/promo-payload.ts';

const orderBadge = (s: string | null | undefined) => orderStatusBadge(s, orderStatusLabel);
const paymentBadge = (s: string | null | undefined) => paymentStatusBadge(s, paymentStatusLabel);
const courierOf = (o: Parameters<typeof orderCourier>[0]) => orderCourier(o, COURIER_LABELS);

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

/** Read the enum members straight from the Prisma schema, so a new status cannot slip through unmapped. */
function prismaEnum(name: string): string[] {
  const schema = readFileSync(join(ROOT, '..', 'backend', 'prisma', 'schema.prisma'), 'utf8');
  const body = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? '';
  return body.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
}

test('every OrderStatus and PaymentStatus has an explicit tone (and nothing extra)', () => {
  const order = prismaEnum('OrderStatus');
  const payment = prismaEnum('PaymentStatus');
  assert.ok(order.length >= 8 && payment.length >= 6, 'enums parsed');
  assert.deepEqual(Object.keys(ORDER_STATUS_TONES).sort(), [...order].sort());
  assert.deepEqual(Object.keys(PAYMENT_STATUS_TONES).sort(), [...payment].sort());
});

test('order and payment statuses are distinct colored badges with Indonesian labels', () => {
  assert.deepEqual(orderBadge('PENDING'), { label: 'Menunggu pembayaran', tone: 'warning' });
  assert.deepEqual(orderBadge('COMPLETED'), { label: 'Selesai', tone: 'success' });
  assert.deepEqual(orderBadge('CANCELLED'), { label: 'Dibatalkan', tone: 'danger' });
  assert.deepEqual(paymentBadge('PAID'), { label: 'Lunas', tone: 'success' });
  assert.deepEqual(paymentBadge('WAITING_VERIFICATION'), { label: 'Menunggu verifikasi', tone: 'info' });
  assert.deepEqual(paymentBadge('FAILED'), { label: 'Gagal', tone: 'danger' });
});

test('unknown statuses fall back safely: neutral tone, raw value shown', () => {
  assert.deepEqual(orderBadge('ON_HOLD'), { label: 'ON_HOLD', tone: 'neutral' });
  assert.deepEqual(paymentBadge('CHARGEBACK'), { label: 'CHARGEBACK', tone: 'neutral' });
  assert.deepEqual(orderBadge(undefined), { label: '—', tone: 'neutral' });
  assert.deepEqual(orderBadge('constructor'), { label: 'constructor', tone: 'neutral' }, 'no prototype lookups');
  assert.deepEqual(paymentBadge(null), { label: 'Belum ada pembayaran', tone: 'neutral' });
});

test('courier: the booked shipment first, else the checkout choice; never guessed', () => {
  assert.deepEqual(
    courierOf({ shippingProvider: 'paxel', shippingServiceName: 'Paxel Instant', shipment: { provider: 'jne', service: 'REG' } }),
    { courier: 'JNE', service: 'REG' },
    'booked with another courier: that courier and its own service, never the checkout service',
  );
  assert.deepEqual(courierOf({ shippingProvider: 'jne', shippingService: 'REG23', shipment: null }), { courier: 'JNE', service: 'REG23' });
  assert.deepEqual(
    courierOf({ shippingProvider: 'paxel', shippingServiceName: 'Paxel Instant', shippingService: 'INSTANT', shipment: { provider: 'paxel', service: 'instant' } }),
    { courier: 'Paxel', service: 'Paxel Instant' },
    'same courier: the label quoted at checkout first',
  );
  assert.deepEqual(courierOf({ shippingProvider: 'paxel' }), { courier: 'Paxel', service: null });
  assert.deepEqual(courierOf({ shipment: { provider: 'paxel', service: 'Same Day' } }), { courier: 'Paxel', service: 'Same Day' });
  assert.deepEqual(courierOf({}), { courier: '—', service: null });
  assert.deepEqual(courierOf({ shippingProvider: '  ', shipment: { provider: '' } }), { courier: '—', service: null });
  assert.equal(courierLabel('SiCepat', COURIER_LABELS), 'SiCepat', 'an unlisted provider is shown as recorded');
});

test('order list renders a Kurir column and both status badges from these helpers', () => {
  const page = read('app/orders/page.tsx');
  assert.match(page, /<th className="py-3 font-medium">Kurir<\/th>/);
  assert.match(page, /<OrderStatusCells order=\{order\} \/>/);
  assert.match(page, /const orderBadge = orderStatusBadge\(order\.status, orderStatusLabel\);/);
  assert.match(page, /const paymentBadge = paymentStatusBadge\(order\.payment\?\.status, paymentStatusLabel\);/);
  assert.match(page, /const courier = orderCourier\(order, COURIER_LABELS\);/);
  assert.match(page, /<Badge tone=\{orderBadge\.tone\} data-status=\{order\.status\}>/);
  assert.match(page, /<Badge tone=\{paymentBadge\.tone\}/);
  assert.doesNotMatch(page, /order\.payment\?\.status \?\? order\.paymentMethod/, 'raw enum text replaced');
  assert.match(read('components/ui/badge.tsx'), /warning: 'bg-amber-50 text-amber-700', info: 'bg-sky-50 text-sky-700',/);
});
