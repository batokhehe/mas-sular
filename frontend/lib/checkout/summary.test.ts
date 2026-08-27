import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkoutSummaryRows,
  successPaymentView,
  paymentBreakdownRows,
  paymentBreakdownFromOrder,
  paymentBreakdownFromUpload,
} from './summary.ts'

const rowValue = (rows: Array<{ key: string; value: number }>, key: string) => rows.find((r) => r.key === key)?.value
const hasRow = (rows: Array<{ key: string }>, key: string) => rows.some((r) => r.key === key)

// Backend /checkout/summary response fixture (server-authoritative amounts).
const backendSummary = { subtotal: 120000, shipping_cost: 15000, discount: 5000, payment_service_fee: 0, grand_total: 130000 }

test('checkout summary rows equal the backend response verbatim', () => {
  const byKey = Object.fromEntries(checkoutSummaryRows(backendSummary as never).map((r) => [r.key, r.value]))
  assert.equal(byKey.subtotal, 120000) // backend.subtotal
  assert.equal(byKey.shipping, 15000) // backend.shipping_cost
  assert.equal(byKey.discount, -5000) // backend.discount (shown as a reduction)
  assert.equal(byKey.grand_total, 130000) // backend.grand_total
})

test('frontend NEVER recalculates the grand total — it uses backend.grand_total', () => {
  // Deliberately inconsistent: subtotal + shipping - discount = 130000, backend says 99999.
  const rows = checkoutSummaryRows({ subtotal: 120000, shipping_cost: 15000, discount: 5000, payment_service_fee: 700, grand_total: 99999 } as never)
  const total = rows.find((r) => r.key === 'grand_total')
  assert.equal(total?.value, 99999) // proves no client-side subtotal+shipping-discount math
})

test('checkout summary never contains a unique-code row', () => {
  const rows = checkoutSummaryRows(backendSummary as never)
  assert.ok(rows.every((r) => !/unique/i.test(r.key) && !/unique/i.test(r.label)))
})

test('discount row is omitted when there is no voucher discount', () => {
  const rows = checkoutSummaryRows({ subtotal: 100000, shipping_cost: 10000, discount: 0, payment_service_fee: 0, grand_total: 110000 } as never)
  assert.ok(!rows.some((r) => r.key === 'discount'))
})

test('checkout renders backend-provided Biaya Layanan without calculating it itself', () => {
  const rows = checkoutSummaryRows({
    subtotal: 100000,
    shipping_cost: 10000,
    discount: 5000,
    // Deliberately inconsistent with any frontend formula: backend is authoritative.
    payment_service_fee: 777,
    grand_total: 105777,
  } as never)
  const fee = rows.find((r) => r.key === 'payment_service_fee')
  assert.deepEqual(fee, { key: 'payment_service_fee', label: 'Biaya Layanan', value: 777 })
  assert.equal(rows.find((r) => r.key === 'grand_total')?.value, 105777)
})

// Created-order fixture (POST /checkout/order response).
const paidOrder = {
  totalPrice: 130000,
  subtotal: 120000,
  deliveryFee: 15000,
  voucherDiscountAmount: 5000,
  payment: { amount: 130321, uniqueCode: 321 },
}

test('success page shows backend payment.amount as "Transfer exactly"', () => {
  const view = successPaymentView(paidOrder as never)
  assert.equal(view.transferExactly, 130321) // Payment.amount, NOT totalPrice
  assert.equal(view.businessTotal, 130000) // Order.totalPrice (business revenue)
})

test('success page shows backend payment.uniqueCode', () => {
  const view = successPaymentView(paidOrder as never)
  assert.equal(view.hasUniqueCode, true)
  assert.equal(view.uniqueCode, 321)
})

test('success view falls back to totalPrice and hides the code when uniqueCode is null', () => {
  const view = successPaymentView({
    totalPrice: 110000, subtotal: 100000, deliveryFee: 10000, voucherDiscountAmount: 0,
    payment: { amount: 110000, uniqueCode: null },
  } as never)
  assert.equal(view.hasUniqueCode, false)
  assert.equal(view.transferExactly, 110000)
  assert.equal(view.uniqueCode, null)
})

// ---------------- Payment breakdown (success + upload pages) ----------------

const bankOrder = {
  paymentMethod: 'BANK_TRANSFER', totalPrice: 130000, subtotal: 120000, deliveryFee: 15000,
  voucherDiscountAmount: 5000, payment: { amount: 130321, uniqueCode: 321 },
}

test('BANK_TRANSFER breakdown displays Business Total, Unique Payment Code, and Transfer Exactly', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromOrder(bankOrder as never))
  assert.ok(hasRow(rows, 'business_total'))
  assert.ok(hasRow(rows, 'unique_code'))
  assert.ok(hasRow(rows, 'transfer_exactly'))
  assert.equal(rowValue(rows, 'business_total'), 130000) // Order.totalPrice
})

test('the displayed transfer amount equals backend payment.amount', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromOrder(bankOrder as never))
  assert.equal(rowValue(rows, 'transfer_exactly'), 130321) // == payment.amount, NOT totalPrice
})

test('the unique code is rendered exactly as received from the backend', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromOrder(bankOrder as never))
  assert.equal(rowValue(rows, 'unique_code'), 321) // == payment.uniqueCode
})

test('QRIS/COD do not display the unique code section', () => {
  const qris = paymentBreakdownRows(paymentBreakdownFromOrder({ paymentMethod: 'QRIS', totalPrice: 130000, subtotal: 120000, deliveryFee: 10000, voucherDiscountAmount: 0, payment: { amount: 130000, uniqueCode: null } } as never))
  const cod = paymentBreakdownRows(paymentBreakdownFromOrder({ paymentMethod: 'COD', totalPrice: 130000, subtotal: 120000, deliveryFee: 10000, voucherDiscountAmount: 0, payment: null } as never))
  assert.equal(hasRow(qris, 'unique_code'), false)
  assert.equal(hasRow(cod, 'unique_code'), false)
})

test('uniqueCode = null hides the section; Business Total equals Transfer Exactly', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromOrder({ paymentMethod: 'BANK_TRANSFER', totalPrice: 130000, subtotal: 120000, deliveryFee: 10000, voucherDiscountAmount: 0, payment: { amount: 130000, uniqueCode: null } } as never))
  assert.equal(hasRow(rows, 'unique_code'), false)
  assert.equal(rowValue(rows, 'business_total'), rowValue(rows, 'transfer_exactly')) // same value
})

test('breakdown performs NO money math — every value is a verbatim backend number', () => {
  // Deliberately inconsistent: transfer (999) is NOT businessTotal(130000)+code(321).
  const rows = paymentBreakdownRows({ businessTotal: 130000, uniqueCode: 321, transferExactly: 999 })
  assert.equal(rowValue(rows, 'business_total'), 130000)
  assert.equal(rowValue(rows, 'unique_code'), 321)
  assert.equal(rowValue(rows, 'transfer_exactly'), 999) // rendered as-is, not recomputed
})

test('upload breakdown uses the backend businessTotal (not amount - code)', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromUpload({ orderNumber: 'BMS-1', amount: 130321, businessTotal: 130000, uniqueCode: 321, method: 'BANK_TRANSFER', status: 'PENDING' } as never))
  assert.equal(rowValue(rows, 'business_total'), 130000) // backend businessTotal
  assert.equal(rowValue(rows, 'transfer_exactly'), 130321) // backend amount
  assert.equal(rowValue(rows, 'unique_code'), 321)
})

test('upload breakdown falls back to amount for legacy responses without businessTotal', () => {
  const rows = paymentBreakdownRows(paymentBreakdownFromUpload({ orderNumber: 'BMS-1', amount: 110000, uniqueCode: null, method: 'QRIS', status: 'PENDING' } as never))
  assert.equal(hasRow(rows, 'unique_code'), false)
  assert.equal(rowValue(rows, 'business_total'), 110000)
  assert.equal(rowValue(rows, 'transfer_exactly'), 110000)
})
