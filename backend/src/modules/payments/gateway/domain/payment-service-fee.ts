import { PaymentChannelCode } from './payment-channel';

/**
 * Payment service fee — the fee Midtrans charges the MERCHANT for a payment, and
 * who bears it.
 *
 * Two independent switches (see payment-service-fee.config.ts):
 *   MIDTRANS_ENABLED            is the gateway available at all (unchanged);
 *   PAYMENT_SERVICE_FEE_ENABLED who bears the applicable fee:
 *     true  -> added to the customer's payable total ("Biaya Layanan");
 *     false -> customer pays Rp0, the merchant absorbs it.
 * In BOTH modes the applicable fee is calculated and recorded, so the merchant's
 * real processing cost is never lost.
 *
 * Every amount is decided here, on the server. The storefront only displays what
 * this returns; the gateway is charged exactly `customerTotal`.
 */
export type PaymentServiceFeeType = 'NONE' | 'FIXED' | 'PERCENTAGE' | 'PERCENTAGE_PLUS_FIXED';

/**
 * Whether the fee may be passed to the customer when the global toggle is on.
 *   ALLOWED    follows PAYMENT_SERVICE_FEE_ENABLED;
 *   PROHIBITED never passed on, whatever the toggle says (customer fee Rp0, merchant absorbs).
 */
export type PaymentServiceFeePassThrough = 'ALLOWED' | 'PROHIBITED';

export interface PaymentServiceFeeRule {
  channel: PaymentChannelCode;
  type: PaymentServiceFeeType;
  /** Percentage in basis points (70 = 0.7%). 0 when the rule has no percentage part. */
  rateBps: number;
  /** Fixed part in rupiah. 0 when the rule has no fixed part. */
  fixedAmount: number;
  /** Midtrans' list price already includes VAT (true for QRIS/GoPay/ShopeePay per the pricing page). */
  vatIncluded: boolean;
  passThrough: PaymentServiceFeePassThrough;
  /** Why pass-through is prohibited/conditional — recorded with every snapshot. */
  basis: string;
}

/** Version of the rule table below; recorded with every snapshot. */
export const PAYMENT_SERVICE_FEE_RULES_VERSION = 'midtrans-pricing-2026-09';

const QRIS_BASIS =
  'Bank Indonesia: QRIS MDR "ditanggung oleh merchant dan tidak boleh dibebankan kepada konsumen"; PBI 23/6/PBI/2021 Pasal 52';
const CARD_BASIS = 'Bank Indonesia card (APMK) surcharge prohibition and card-network rules; PBI 23/6/PBI/2021 Pasal 52';
const PJP_BASIS =
  'PBI 23/6/PBI/2021 Pasal 52 prohibits surcharging PJP fees; pass-through requires written Midtrans/legal confirmation';

const va = (channel: PaymentChannelCode): PaymentServiceFeeRule => ({
  channel, type: 'FIXED', rateBps: 0, fixedAmount: 4_000, vatIncluded: false, passThrough: 'ALLOWED', basis: PJP_BASIS,
});
const ewallet = (channel: PaymentChannelCode, rateBps: number): PaymentServiceFeeRule => ({
  channel, type: 'PERCENTAGE', rateBps, fixedAmount: 0, vatIncluded: true, passThrough: 'ALLOWED', basis: PJP_BASIS,
});

/**
 * Midtrans price list (https://midtrans.com/pricing, 2026-09): QRIS 0.7%, GoPay 2%,
 * ShopeePay 2%, every bank VA Rp4,000, cards 2.9% + Rp2,000. Prices exclude VAT
 * except QRIS, GoPay and ShopeePay. MANUAL_TRANSFER is not a Midtrans channel.
 */
export const PAYMENT_SERVICE_FEE_RULES: Readonly<Partial<Record<PaymentChannelCode, PaymentServiceFeeRule>>> = {
  QRIS: { channel: 'QRIS', type: 'PERCENTAGE', rateBps: 70, fixedAmount: 0, vatIncluded: true, passThrough: 'PROHIBITED', basis: QRIS_BASIS },
  GOPAY: ewallet('GOPAY', 200),
  SHOPEEPAY: ewallet('SHOPEEPAY', 200),
  BCA_VA: va('BCA_VA'),
  BNI_VA: va('BNI_VA'),
  BRI_VA: va('BRI_VA'),
  PERMATA_VA: va('PERMATA_VA'),
  MANDIRI_BILL: va('MANDIRI_BILL'),
  CREDIT_CARD: {
    channel: 'CREDIT_CARD', type: 'PERCENTAGE_PLUS_FIXED', rateBps: 290, fixedAmount: 2_000, vatIncluded: false,
    passThrough: 'PROHIBITED', basis: CARD_BASIS,
  },
};

/** Recorded with the order and with every payment attempt. JSON-safe. */
export interface PaymentServiceFeeRuleSnapshot {
  version: string;
  /**
   * The pass-through switch that applied (PAYMENT_FEE_<channel>_ENABLED or the inherited
   * PAYMENT_SERVICE_FEE_ENABLED). Absent on snapshots recorded before per-channel flags.
   */
  setting?: { enabled: boolean; variable: string; source: 'CHANNEL' | 'GLOBAL' };
  channel: string;
  type: PaymentServiceFeeType;
  rateBps: number;
  fixedAmount: number;
  vatIncluded: boolean;
  passThrough: PaymentServiceFeePassThrough;
  basis: string;
}

export interface PaymentServiceFeeBreakdown {
  /** Channel the fee was calculated for; null when none was chosen. */
  channel: string | null;
  /** The effective pass-through switch for this channel at calculation time. */
  feeEnabled: boolean;
  /** Fee-exclusive payable amount: subtotal + shipping - discount. */
  transactionBase: number;
  /** The applicable Midtrans fee for this channel and base (list price). */
  calculatedFee: number;
  /** The part added to the customer's total. */
  customerFee: number;
  /** The part the merchant bears: calculatedFee - customerFee. */
  merchantAbsorbedFee: number;
  /** customerTotal = transactionBase + customerFee — the amount the gateway is charged. */
  customerTotal: number;
  /** Set when the toggle is on but this channel may not pass the fee to the customer. */
  passThroughBlockedReason: string | null;
  rule: PaymentServiceFeeRuleSnapshot | null;
}

/** Nearest-rupiah percentage of an integer amount (half-up), in basis points. */
function percentOf(amount: number, rateBps: number): number {
  return Math.round((amount * rateBps) / 10_000);
}

function applicableFee(rule: PaymentServiceFeeRule, base: number): number {
  switch (rule.type) {
    case 'FIXED':
      return rule.fixedAmount;
    case 'PERCENTAGE':
      return percentOf(base, rule.rateBps);
    case 'PERCENTAGE_PLUS_FIXED':
      return percentOf(base, rule.rateBps) + rule.fixedAmount;
    default:
      return 0;
  }
}

export function ruleFor(channel: string | null | undefined): PaymentServiceFeeRule | null {
  if (!channel) return null;
  return PAYMENT_SERVICE_FEE_RULES[channel.toUpperCase() as PaymentChannelCode] ?? null;
}

/**
 * The single, authoritative fee calculation. Pure and deterministic.
 *
 * The fee is calculated on the fee-exclusive base in both modes, so the two
 * modes differ ONLY in who pays it. (For percentage channels Midtrans deducts its
 * percentage from the gross it actually receives; when the fee is passed on, that
 * gross includes the fee, so the real deduction is a few rupiah above
 * `calculatedFee`. Reconcile against the Midtrans settlement report.)
 */
export function calculatePaymentServiceFee(input: {
  paymentChannel?: string | null;
  transactionBase: number;
  feeEnabled: boolean;
  /** Which variable produced `feeEnabled`; recorded in the rule snapshot when given. */
  setting?: { variable: string; source: 'CHANNEL' | 'GLOBAL' };
}): PaymentServiceFeeBreakdown {
  const channel = input.paymentChannel ? input.paymentChannel.toUpperCase() : null;
  const validBase = Number.isFinite(input.transactionBase) && input.transactionBase > 0;
  const base = validBase ? input.transactionBase : 0;
  const rule = ruleFor(channel);

  // No Midtrans rule for this channel (manual transfer, none chosen) or nothing to
  // charge: no fee at all, and nothing for the merchant to absorb either.
  if (!rule || !validBase) {
    return {
      channel,
      feeEnabled: input.feeEnabled,
      transactionBase: base,
      calculatedFee: 0,
      customerFee: 0,
      merchantAbsorbedFee: 0,
      customerTotal: base,
      passThroughBlockedReason: null,
      rule: rule ? snapshotOf(rule, input) : null,
    };
  }

  const calculatedFee = applicableFee(rule, base);
  const prohibited = rule.passThrough === 'PROHIBITED';
  const customerFee = input.feeEnabled && !prohibited ? calculatedFee : 0;
  return {
    channel,
    feeEnabled: input.feeEnabled,
    transactionBase: base,
    calculatedFee,
    customerFee,
    merchantAbsorbedFee: calculatedFee - customerFee,
    customerTotal: base + customerFee,
    passThroughBlockedReason: input.feeEnabled && prohibited ? `PASS_THROUGH_PROHIBITED:${rule.channel}` : null,
    rule: snapshotOf(rule, input),
  };
}

function snapshotOf(
  rule: PaymentServiceFeeRule,
  input: { feeEnabled: boolean; setting?: { variable: string; source: 'CHANNEL' | 'GLOBAL' } },
): PaymentServiceFeeRuleSnapshot {
  return {
    version: PAYMENT_SERVICE_FEE_RULES_VERSION,
    ...(input.setting ? { setting: { enabled: input.feeEnabled, variable: input.setting.variable, source: input.setting.source } } : {}),
    channel: rule.channel,
    type: rule.type,
    rateBps: rule.rateBps,
    fixedAmount: rule.fixedAmount,
    vatIncluded: rule.vatIncluded,
    passThrough: rule.passThrough,
    basis: rule.basis,
  };
}
