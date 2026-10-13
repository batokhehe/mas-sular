import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feeModeLabel, feeRuleLabel, type ServiceFeeRuleSnapshot } from './service-fee-view.ts';

/**
 * Admin Order Detail — payment service fee panel. The backend records the fee
 * (both PAYMENT_SERVICE_FEE_ENABLED modes); the panel only labels that snapshot.
 */

const rule = (over: Partial<ServiceFeeRuleSnapshot>): ServiceFeeRuleSnapshot => ({
  version: 'midtrans-pricing-2026-09', channel: 'BNI_VA', type: 'FIXED', rateBps: 0, fixedAmount: 4000,
  vatIncluded: false, passThrough: 'ALLOWED', basis: 'x', ...over,
});

test('rule labels follow the Midtrans pricing shapes', () => {
  assert.equal(feeRuleLabel(rule({})), 'Rp 4.000 (excl. VAT)');
  assert.equal(feeRuleLabel(rule({ channel: 'QRIS', type: 'PERCENTAGE', rateBps: 70, fixedAmount: 0, vatIncluded: true })), '0.7% (incl. VAT)');
  assert.equal(feeRuleLabel(rule({ channel: 'GOPAY', type: 'PERCENTAGE', rateBps: 200, fixedAmount: 0, vatIncluded: true })), '2% (incl. VAT)');
  assert.equal(feeRuleLabel(rule({ channel: 'CREDIT_CARD', type: 'PERCENTAGE_PLUS_FIXED', rateBps: 290, fixedAmount: 2000 })), '2.9% + Rp 2.000 (excl. VAT)');
  assert.equal(feeRuleLabel(null), '—');
});

test('fee mode says who bore the fee, including the compliance override', () => {
  assert.match(feeModeLabel(false, rule({})), /^Ditanggung merchant \(PAYMENT_SERVICE_FEE_ENABLED=false\)/);
  assert.match(feeModeLabel(true, rule({})), /^Dibayar pelanggan/);
  assert.match(feeModeLabel(true, rule({ channel: 'QRIS', passThrough: 'PROHIBITED' })), /tidak boleh dibebankan ke pelanggan/);
  assert.equal(feeModeLabel(null, null), '—'); // orders recorded before the breakdown
});

test('fee mode names the per-channel variable that decided it, when the snapshot records one', () => {
  const channel = { enabled: false, variable: 'PAYMENT_FEE_VA_BRI_ENABLED', source: 'CHANNEL' as const };
  assert.equal(feeModeLabel(false, rule({ channel: 'BRI_VA', setting: channel })), 'Ditanggung merchant (PAYMENT_FEE_VA_BRI_ENABLED=false)');
  assert.equal(
    feeModeLabel(true, rule({ channel: 'GOPAY', setting: { enabled: true, variable: 'PAYMENT_FEE_EWALLET_GOPAY_ENABLED', source: 'CHANNEL' } })),
    'Dibayar pelanggan (PAYMENT_FEE_EWALLET_GOPAY_ENABLED=true)',
  );
  // Inherited from the global switch.
  assert.equal(
    feeModeLabel(true, rule({ setting: { enabled: true, variable: 'PAYMENT_SERVICE_FEE_ENABLED', source: 'GLOBAL' } })),
    'Dibayar pelanggan (PAYMENT_SERVICE_FEE_ENABLED=true)',
  );
});

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PAGE = strip(readFileSync(join(process.cwd(), 'app/orders/[id]/page.tsx'), 'utf8'));

test('Order Detail shows the recorded fee breakdown for gateway orders, never recomputed', () => {
  assert.match(PAGE, /const isGateway = \(payment\?\.method \?\? order\.paymentMethod\) === 'GATEWAY';/);
  for (const field of [
    'rp(order.paymentServiceFeeCalculated ?? 0)', 'rp(order.paymentServiceFee ?? 0)', 'rp(order.paymentServiceFeeAbsorbed ?? 0)',
    'feeModeLabel(order.paymentServiceFeeEnabled, order.paymentServiceFeeRule)', 'feeRuleLabel(order.paymentServiceFeeRule)',
    "order.paymentServiceFeeChannel ?? '—'", 'rp(gateway.grossAmount)', 'rp(gateway.baseAmount)',
  ]) {
    assert.ok(PAGE.includes(field), `renders ${field}`);
  }
  assert.equal(/paymentServiceFee(Calculated)?\s*[-+]\s*order\./.test(PAGE), false, 'no client-side fee math');
});
