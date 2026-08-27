import type { CheckoutSummary, Order, UploadPage } from '@/lib/types/models'

/**
 * PURE, backend-passthrough selectors for every monetary value shown at checkout.
 *
 * These functions perform NO arithmetic on money — they only read the amounts the
 * backend already computed (subtotal / shipping / discount / grand total from the
 * checkout-summary endpoint, and business/transfer/uniqueCode from the created
 * order). Keeping the math out of React components makes the backend the single
 * source of truth and lets us regression-test that the UI never recalculates.
 */

export type SummaryRow = { key: string; label: string; value: number }

/**
 * Rows for the checkout Order Summary. The grand total is `summary.grand_total`
 * verbatim — NEVER `subtotal + shipping - discount` recomputed on the client.
 * There is deliberately no unique-code row: the code does not exist until the
 * order is created (post-checkout).
 */
export function checkoutSummaryRows(summary: CheckoutSummary): SummaryRow[] {
  const rows: SummaryRow[] = [
    { key: 'subtotal', label: 'Subtotal', value: summary.subtotal },
    { key: 'shipping', label: 'Shipping', value: summary.shipping_cost },
  ]
  if (summary.discount > 0) {
    rows.push({ key: 'discount', label: 'Discount', value: -summary.discount })
  }
  if (summary.payment_service_fee > 0) {
    rows.push({ key: 'payment_service_fee', label: 'Biaya Layanan', value: summary.payment_service_fee })
  }
  rows.push({ key: 'grand_total', label: 'Grand total', value: summary.grand_total })
  return rows
}

export type SuccessPaymentView = {
  /** True only when the created payment carries a manual BANK_TRANSFER unique code. */
  hasUniqueCode: boolean
  businessTotal: number
  subtotal: number
  shipping: number
  discount: number
  uniqueCode: number | null
  /** The exact amount the customer must transfer = Payment.amount (business + code). */
  transferExactly: number
}

/**
 * Post-order payment breakdown for the success page — a pure passthrough of the
 * created order + payment. `transferExactly` is `payment.amount` (NOT `totalPrice`),
 * and `uniqueCode` is `payment.uniqueCode`, both straight from the backend.
 */
export function successPaymentView(order: Order): SuccessPaymentView {
  const uniqueCode = order.payment?.uniqueCode ?? null
  return {
    hasUniqueCode: uniqueCode != null,
    businessTotal: order.totalPrice,
    subtotal: order.subtotal,
    shipping: order.deliveryFee,
    discount: order.voucherDiscountAmount,
    uniqueCode,
    transferExactly: order.payment?.amount ?? order.totalPrice,
  }
}

// ---------------- Shared payment breakdown (success + upload pages) ----------------

export type PaymentBreakdownInput = {
  /** Order.totalPrice — the business revenue (excludes the unique code). */
  businessTotal: number
  /** Payment.uniqueCode — null for QRIS/COD/legacy/disabled. */
  uniqueCode: number | null
  /** Payment.amount — the exact amount to transfer (business + code). */
  transferExactly: number
  /** Line items (success page only); the upload page omits them. */
  itemization?: { subtotal: number; shipping: number; discount: number }
}

export type PaymentBreakdownRow = {
  key: string
  label: string
  value: number
  kind: 'line' | 'discount' | 'business' | 'code' | 'transfer'
}

/**
 * Build the ordered rows for the payment breakdown. PURE passthrough — every value
 * is a backend number (business total, unique code, transfer total); nothing is
 * added or derived here. The unique-code row is present ONLY when a code exists.
 */
export function paymentBreakdownRows(input: PaymentBreakdownInput): PaymentBreakdownRow[] {
  const rows: PaymentBreakdownRow[] = []
  if (input.itemization) {
    rows.push({ key: 'subtotal', label: 'Subtotal', value: input.itemization.subtotal, kind: 'line' })
    rows.push({ key: 'shipping', label: 'Shipping', value: input.itemization.shipping, kind: 'line' })
    if (input.itemization.discount > 0) {
      rows.push({ key: 'discount', label: 'Voucher Discount', value: input.itemization.discount, kind: 'discount' })
    }
  }
  rows.push({ key: 'business_total', label: 'Business Total', value: input.businessTotal, kind: 'business' })
  if (input.uniqueCode != null) {
    rows.push({ key: 'unique_code', label: 'Unique Payment Code', value: input.uniqueCode, kind: 'code' })
  }
  rows.push({ key: 'transfer_exactly', label: 'Transfer Exactly', value: input.transferExactly, kind: 'transfer' })
  return rows
}

/** Success-page breakdown input, straight from the created order (with itemization). */
export function paymentBreakdownFromOrder(order: Order): PaymentBreakdownInput {
  const view = successPaymentView(order)
  return {
    businessTotal: view.businessTotal,
    uniqueCode: view.uniqueCode,
    transferExactly: view.transferExactly,
    itemization: { subtotal: view.subtotal, shipping: view.shipping, discount: view.discount },
  }
}

/** Upload-page breakdown input, from the token upload-page payload (no itemization). */
export function paymentBreakdownFromUpload(page: UploadPage): PaymentBreakdownInput {
  return {
    // businessTotal is provided by the backend; fall back to `amount` for legacy
    // responses (where amount == business total because there is no code).
    businessTotal: page.businessTotal ?? page.amount,
    uniqueCode: page.uniqueCode ?? null,
    transferExactly: page.amount,
  }
}
