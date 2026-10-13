/**
 * Merchant-side payment service fee accounting. Recorded on every gateway order
 * (PAYMENT_SERVICE_FEE_ENABLED true or false) for reconciliation and the admin
 * view, but never part of a customer response: the customer sees only the
 * customer-charged `paymentServiceFee` ("Biaya Layanan", Rp0 when absorbed).
 */
export const MERCHANT_FEE_FIELDS = [
  'paymentServiceFeeCalculated',
  'paymentServiceFeeAbsorbed',
  'paymentServiceFeeEnabled',
  'paymentServiceFeeChannel',
  'paymentServiceFeeRule',
] as const;

type MerchantFeeField = (typeof MERCHANT_FEE_FIELDS)[number];

/** The order as a customer may see it: every existing field, minus the merchant fee accounting. */
export function toCustomerOrder<T extends object>(order: T): Omit<T, MerchantFeeField> {
  const view = { ...order } as Record<string, unknown>;
  for (const field of MERCHANT_FEE_FIELDS) delete view[field];
  return view as Omit<T, MerchantFeeField>;
}
