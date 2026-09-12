/**
 * PAYMENT_SERVICE_FEE_ENABLED — who bears the applicable Midtrans payment service fee.
 *
 * Deliberately INDEPENDENT of MIDTRANS_ENABLED: that switch decides whether the
 * gateway is available; this one only decides whether the fee is added to the
 * customer's total (true) or absorbed by the merchant (false, the default).
 * Only the exact string "true" enables pass-through; anything else is absorb.
 */
export const PAYMENT_SERVICE_FEE_CONFIG = 'PAYMENT_SERVICE_FEE_CONFIG';

export interface PaymentServiceFeeConfig {
  /** true: the customer pays the applicable fee; false: the merchant absorbs it. */
  enabled: boolean;
}

export function loadPaymentServiceFeeConfig(env: NodeJS.ProcessEnv = process.env): PaymentServiceFeeConfig {
  return { enabled: env.PAYMENT_SERVICE_FEE_ENABLED === 'true' };
}
