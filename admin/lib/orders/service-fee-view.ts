/**
 * Display helpers for the Admin "Payment Service Fee" panel.
 *
 * Every amount is the backend's recorded snapshot (Order.paymentServiceFee*,
 * PaymentGatewayTransaction.serviceFee*): nothing is recalculated here. The panel
 * exists so operations can see, per order, the Midtrans fee that applied, how
 * much the customer paid ("Biaya Layanan") and how much the merchant absorbed —
 * in both PAYMENT_SERVICE_FEE_ENABLED modes.
 */

/** The rule snapshot the backend stores with each fee (payment-service-fee.ts). */
export type ServiceFeeRuleSnapshot = {
  version: string;
  channel: string;
  type: 'NONE' | 'FIXED' | 'PERCENTAGE' | 'PERCENTAGE_PLUS_FIXED';
  rateBps: number;
  fixedAmount: number;
  vatIncluded: boolean;
  passThrough: 'ALLOWED' | 'PROHIBITED';
  basis: string;
};

const rupiah = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
/** Basis points as a percentage: 290 -> "2.9%", 70 -> "0.7%", 200 -> "2%". */
const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** "Rp 4.000", "0.7%", "2.9% + Rp 2.000" — plus the VAT note the pricing page gives. */
export function feeRuleLabel(rule: ServiceFeeRuleSnapshot | null | undefined): string {
  if (!rule) return '—';
  const amount =
    rule.type === 'FIXED' ? rupiah(rule.fixedAmount)
      : rule.type === 'PERCENTAGE' ? percent(rule.rateBps)
        : rule.type === 'PERCENTAGE_PLUS_FIXED' ? `${percent(rule.rateBps)} + ${rupiah(rule.fixedAmount)}`
          : 'No fee';
  return `${amount} (${rule.vatIncluded ? 'incl. VAT' : 'excl. VAT'})`;
}

/** Who bore the fee on this order, from the recorded toggle and rule. */
export function feeModeLabel(enabled: boolean | null | undefined, rule: ServiceFeeRuleSnapshot | null | undefined): string {
  if (enabled == null) return '—'; // recorded before the fee breakdown existed
  if (!enabled) return 'Merchant absorbs (PAYMENT_SERVICE_FEE_ENABLED=false)';
  if (rule?.passThrough === 'PROHIBITED') return 'Merchant absorbs (pass-through prohibited for this channel)';
  return 'Customer pays (PAYMENT_SERVICE_FEE_ENABLED=true)';
}
