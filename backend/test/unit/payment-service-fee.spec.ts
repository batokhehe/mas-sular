import { PAYMENT_CHANNELS } from '../../src/modules/payments/gateway/domain/payment-channel';
import {
  calculatePaymentServiceFee,
  PAYMENT_SERVICE_FEE_RULES,
  PAYMENT_SERVICE_FEE_RULES_VERSION,
} from '../../src/modules/payments/gateway/domain/payment-service-fee';
import { loadPaymentServiceFeeConfig } from '../../src/modules/payments/gateway/payment-service-fee.config';
import { validateEnv } from '../../src/common/config/env.validation';

/**
 * PAYMENT_SERVICE_FEE_ENABLED — who bears the applicable Midtrans fee.
 *   true  -> the customer pays it ("Biaya Layanan"), except where pass-through is prohibited;
 *   false -> the customer pays Rp0 and the merchant absorbs it.
 * The applicable fee is calculated and recorded in BOTH modes.
 */
const fee = (paymentChannel: string | null | undefined, transactionBase: number, feeEnabled: boolean) =>
  calculatePaymentServiceFee({ paymentChannel, transactionBase, feeEnabled });

describe('Midtrans fee rule table (midtrans.com/pricing, 2026-09)', () => {
  it.each([
    ['QRIS', 700],
    ['GOPAY', 2_000],
    ['SHOPEEPAY', 2_000],
    ['BCA_VA', 4_000],
    ['BNI_VA', 4_000],
    ['BRI_VA', 4_000],
    ['PERMATA_VA', 4_000],
    ['MANDIRI_BILL', 4_000],
    ['CREDIT_CARD', 4_900], // 2.9% + Rp2,000
  ])('%s: applicable fee on Rp100,000 is %i', (channel, calculated) => {
    expect(fee(channel, 100_000, false).calculatedFee).toBe(calculated);
    expect(fee(channel, 100_000, true).calculatedFee).toBe(calculated);
  });

  it('every Midtrans channel in the catalog has a rule - none silently resolves to Rp0', () => {
    const gatewayChannels = PAYMENT_CHANNELS.filter((c) => c.code !== 'MANUAL_TRANSFER').map((c) => c.code);
    expect(gatewayChannels.filter((code) => !PAYMENT_SERVICE_FEE_RULES[code])).toEqual([]);
    for (const code of gatewayChannels) expect(fee(code, 100_000, true).calculatedFee).toBeGreaterThan(0);
  });

  it('pass-through is prohibited exactly for QRIS and cards, each with its recorded basis', () => {
    const prohibited = Object.values(PAYMENT_SERVICE_FEE_RULES).filter((r) => r!.passThrough === 'PROHIBITED').map((r) => r!.channel);
    expect(prohibited.sort()).toEqual(['CREDIT_CARD', 'QRIS']);
    for (const rule of Object.values(PAYMENT_SERVICE_FEE_RULES)) expect(rule!.basis.length).toBeGreaterThan(20);
  });

  it('VAT status follows the pricing page: included for QRIS/GoPay/ShopeePay only', () => {
    const included = Object.values(PAYMENT_SERVICE_FEE_RULES).filter((r) => r!.vatIncluded).map((r) => r!.channel);
    expect(included.sort()).toEqual(['GOPAY', 'QRIS', 'SHOPEEPAY']);
  });
});

describe('A. service fee ENABLED: the customer pays the applicable fee', () => {
  // The business example: subtotal 100,000 - discount 10,000 + shipping 15,000.
  const base = 100_000 - 10_000 + 15_000;

  it('VA: fee added to the customer total, nothing absorbed', () => {
    expect(fee('BNI_VA', base, true)).toMatchObject({
      transactionBase: 105_000, calculatedFee: 4_000, customerFee: 4_000, merchantAbsorbedFee: 0, customerTotal: 109_000,
      feeEnabled: true, passThroughBlockedReason: null,
    });
  });

  it('e-wallet: percentage fee added to the customer total', () => {
    expect(fee('GOPAY', base, true)).toMatchObject({ calculatedFee: 2_100, customerFee: 2_100, merchantAbsorbedFee: 0, customerTotal: 107_100 });
  });

  it.each([['QRIS', 735], ['CREDIT_CARD', 5_045]])(
    'COMPLIANCE: %s never passes the fee on, even with the toggle on - the merchant absorbs %i',
    (channel, calculated) => {
      expect(fee(channel, base, true)).toMatchObject({
        calculatedFee: calculated, customerFee: 0, merchantAbsorbedFee: calculated, customerTotal: 105_000,
        passThroughBlockedReason: `PASS_THROUGH_PROHIBITED:${channel}`,
      });
    },
  );
});

describe('B. service fee DISABLED: customer pays Rp0, the merchant cost is still recorded', () => {
  const base = 105_000;

  it.each(['QRIS', 'GOPAY', 'SHOPEEPAY', 'BCA_VA', 'BNI_VA', 'BRI_VA', 'PERMATA_VA', 'MANDIRI_BILL', 'CREDIT_CARD'])(
    '%s: customer fee Rp0, total = base, absorbed = the applicable fee (not zeroed away)',
    (channel) => {
      const b = fee(channel, base, false);
      expect(b.customerFee).toBe(0);
      expect(b.customerTotal).toBe(base);
      expect(b.calculatedFee).toBeGreaterThan(0);
      expect(b.merchantAbsorbedFee).toBe(b.calculatedFee);
      expect(b.feeEnabled).toBe(false);
      expect(b.passThroughBlockedReason).toBeNull();
      expect(b.rule).toMatchObject({ version: PAYMENT_SERVICE_FEE_RULES_VERSION, channel });
    },
  );
});

describe('C/D. invariants and edge cases', () => {
  it('calculated = customer + absorbed and total = base + customer, for every channel, mode and base', () => {
    for (const channel of Object.keys(PAYMENT_SERVICE_FEE_RULES)) {
      for (const enabled of [true, false]) {
        for (const base of [1, 999, 10_001, 105_000, 2_345_678]) {
          const b = fee(channel, base, enabled);
          expect(b.calculatedFee).toBe(b.customerFee + b.merchantAbsorbedFee);
          expect(b.customerTotal).toBe(b.transactionBase + b.customerFee);
          expect(Number.isInteger(b.calculatedFee)).toBe(true);
        }
      }
    }
  });

  it.each([
    ['QRIS', 100_001, 700],
    ['GOPAY', 100_001, 2_000],
    ['GOPAY', 100_025, 2_001], // half-up
    ['CREDIT_CARD', 1_000, 2_029],
  ])('nearest-rupiah rounding: %s on %i -> %i', (channel, base, calculated) => {
    expect(fee(channel, base, false).calculatedFee).toBe(calculated);
  });

  it.each([
    ['QRIS', 0], ['GOPAY', -1], ['QRIS', Number.NaN], ['QRIS', Number.POSITIVE_INFINITY],
    ['UNKNOWN', 100_000], ['MANUAL_TRANSFER', 100_000], [undefined, 100_000], [null, 100_000],
  ])('no fee at all for an invalid base or a non-Midtrans channel (%s, %s)', (channel, base) => {
    const b = fee(channel as string | null | undefined, base as number, true);
    expect(b).toMatchObject({ calculatedFee: 0, customerFee: 0, merchantAbsorbedFee: 0 });
  });

  it('large values stay whole rupiah', () => {
    expect(fee('QRIS', 9_999_999_999, false).calculatedFee).toBe(70_000_000);
  });
});

describe('PAYMENT_SERVICE_FEE_ENABLED configuration', () => {
  it('only the exact string "true" passes the fee on; default is merchant-absorbs', () => {
    expect(loadPaymentServiceFeeConfig({}).enabled).toBe(false);
    for (const raw of ['', 'false', 'TRUE', '1', 'yes']) expect(loadPaymentServiceFeeConfig({ PAYMENT_SERVICE_FEE_ENABLED: raw }).enabled).toBe(false);
    expect(loadPaymentServiceFeeConfig({ PAYMENT_SERVICE_FEE_ENABLED: 'true' }).enabled).toBe(true);
  });

  const base = {
    NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@db:5432/app', REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
    GOOGLE_CLIENT_ID: 'g', APP_URL: 'http://localhost:3001',
  };

  it('is validated as true|false and is independent of MIDTRANS_ENABLED (every combination boots)', () => {
    for (const midtrans of ['true', 'false']) {
      for (const feeFlag of ['true', 'false']) {
        const env = { ...base, MIDTRANS_ENABLED: midtrans, PAYMENT_SERVICE_FEE_ENABLED: feeFlag, ...(midtrans === 'true' ? { MIDTRANS_SERVER_KEY: 'SB-Mid-server-FIXTURE' } : {}) };
        expect(() => validateEnv(env)).not.toThrow();
        expect(validateEnv(env).PAYMENT_SERVICE_FEE_ENABLED).toBe(feeFlag);
        expect(validateEnv(env).MIDTRANS_ENABLED).toBe(midtrans);
      }
    }
    expect(() => validateEnv({ ...base, PAYMENT_SERVICE_FEE_ENABLED: 'yes' })).toThrow(/PAYMENT_SERVICE_FEE_ENABLED/);
  });
});
