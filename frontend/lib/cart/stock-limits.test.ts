import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canIncrease, cartQtyForProduct, clampQty, remainingAddable, stockIssues } from './stock-limits.ts'

// availableStock comes from the catalog API (Stok Produk), never the master stock.

const lines = [
  { productId: 'p1', qty: 2 },
  { productId: 'p1', qty: 1 }, // same product, different toppings
  { productId: 'p2', qty: 4 },
]

test('quantities of one product are summed across topping variants', () => {
  assert.equal(cartQtyForProduct(lines, 'p1'), 3)
  assert.equal(cartQtyForProduct(lines, 'p3'), 0)
})

test('remaining addable quantity respects what the cart already holds', () => {
  assert.equal(remainingAddable(lines, 'p1', 5), 2)
  assert.equal(remainingAddable(lines, 'p1', 3), 0)
  assert.equal(remainingAddable(lines, 'p1', 1), 0) // never negative
  assert.equal(remainingAddable([], 'p1', 4), 4)
})

test('the quantity selector is clamped to availability', () => {
  assert.equal(clampQty(10, 4), 4)
  assert.equal(clampQty(0, 4), 1)
  assert.equal(clampQty(3, 0), 0) // out of stock
})

test('a cart line cannot be increased past availability', () => {
  assert.equal(canIncrease(lines, 'p1', 4), true)
  assert.equal(canIncrease(lines, 'p1', 3), false)
  assert.equal(canIncrease(lines, 'p2', 0), false) // Stok Produk 0
  assert.equal(canIncrease(lines, 'p1', undefined), true) // not loaded: backend decides
})

test('stale cart quantities above current availability are reported per product', () => {
  const availability = new Map([
    ['p1', 2],
    ['p2', 10],
  ])
  assert.deepEqual(stockIssues(lines, availability), [{ productId: 'p1', inCart: 3, available: 2 }])
  assert.deepEqual(stockIssues(lines, new Map()), [])
})
