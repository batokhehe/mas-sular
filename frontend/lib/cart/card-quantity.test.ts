import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Product-card `Tambahkan` / `− qty +` control, driven through the REAL shared cart
 * store (lib/stores/cart-store.ts) - the card keeps no quantity of its own.
 */

const storage = new Map<string, string>()
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  },
})
const { useCartStore, cartLineId, toCheckoutItems } = await import('../stores/cart-store.ts')
const { cardCartState, plainLineId } = await import('./card-quantity.ts')

type AddArg = Parameters<ReturnType<typeof useCartStore.getState>['add']>[0]
const product = (id: string, availableStock: number) =>
  ({ id, slug: `slug-${id}`, name: `Product ${id}`, price: 10_000, imageUrl: `/${id}.jpg`, availableStock }) as AddArg & { availableStock: number }
const BASO = product('baso', 3)
const TEH = product('teh', 10)
const KEJU = { id: 't-keju', name: 'Keju', price: 5_000 }

const cart = () => useCartStore.getState()
const stateOf = (p: { id: string; availableStock: number }) => cardCartState(cart().lines, p.id, p.availableStock)
// What the card's buttons do (product-card.tsx): + / Tambahkan = add(product); − = setQty(plain line, qty - 1).
const tapAdd = (p: AddArg) => cart().add(p)
const tapMinus = (p: { id: string; availableStock: number }) => cart().setQty(plainLineId(p.id), stateOf(p).qty - 1)

beforeEach(() => {
  cart().clear()
})

test('not in the cart: "Tambahkan"', () => {
  assert.deepEqual(stateOf(BASO), { mode: 'add', qty: 0, addOnQty: 0, canIncrement: true })
})

test('after adding: the counter shows 1, on the plain line whose id is the product id', () => {
  tapAdd(BASO)
  assert.deepEqual(stateOf(BASO), { mode: 'counter', qty: 1, addOnQty: 0, canIncrement: true })
  assert.equal(plainLineId('baso'), cartLineId('baso', []))
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty]), [['baso', 1]])
})

test('+ and − change the same line; never a duplicate entry', () => {
  tapAdd(BASO)
  tapAdd(BASO)
  assert.equal(stateOf(BASO).qty, 2)
  tapMinus(BASO)
  assert.equal(stateOf(BASO).qty, 1)
  assert.equal(cart().lines.length, 1)
})

test('− at 1 removes the product and the card returns to "Tambahkan" (never negative)', () => {
  tapAdd(BASO)
  tapMinus(BASO)
  assert.deepEqual(cart().lines, [])
  assert.equal(stateOf(BASO).mode, 'add')
  assert.equal(stateOf(BASO).qty, 0)
})

test('stock limit: + is disabled at availableStock, and the store never exceeds it through the card', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(stateOf(BASO).canIncrement, true, `unit ${i + 1}`)
    tapAdd(BASO)
  }
  assert.deepEqual(stateOf(BASO), { mode: 'counter', qty: 3, addOnQty: 0, canIncrement: false })
  // Stock that dropped below what is held: still the counter (− works), + stays disabled.
  assert.deepEqual(cardCartState(cart().lines, 'baso', 1), { mode: 'counter', qty: 3, addOnQty: 0, canIncrement: false })
  tapMinus({ id: 'baso', availableStock: 1 })
  assert.equal(stateOf(BASO).qty, 2)
})

test('sold out and nothing in the cart: "Stok Habis", nothing addable', () => {
  assert.deepEqual(stateOf(product('kosong', 0)), { mode: 'soldout', qty: 0, addOnQty: 0, canIncrement: false })
})

test('add-on lines: counted against stock, reported, but never changed by the card', () => {
  cart().add(BASO, 2, [KEJU])
  const combo = cartLineId('baso', [KEJU])
  // 2 of 3 units are in an add-on line: "Tambahkan" adds a separate plain line.
  assert.deepEqual(stateOf(BASO), { mode: 'add', qty: 0, addOnQty: 2, canIncrement: true })
  tapAdd(BASO)
  assert.deepEqual(stateOf(BASO), { mode: 'counter', qty: 1, addOnQty: 2, canIncrement: false })
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty]).sort(), [['baso', 1], [combo, 2]].sort())
  // − removes only the plain line; the add-on line is untouched.
  tapMinus(BASO)
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty]), [[combo, 2]])
  // All stock in add-on lines: "Stok di keranjang penuh".
  cart().add(BASO, 1, [KEJU])
  assert.deepEqual(stateOf(BASO), { mode: 'full', qty: 0, addOnQty: 3, canIncrement: false })
})

test('multiple products keep independent quantities', () => {
  tapAdd(BASO)
  tapAdd(TEH)
  tapAdd(TEH)
  tapAdd(TEH)
  tapMinus(BASO)
  assert.equal(stateOf(BASO).mode, 'add')
  assert.equal(stateOf(TEH).qty, 3)
})

test('persisted cart: a refresh (rehydrate from storage) shows the same quantities', async () => {
  tapAdd(BASO)
  tapAdd(BASO)
  tapAdd(TEH)
  const saved = storage.get('ms_cart')
  assert.ok(saved, 'cart persisted')
  // Simulate a new page: empty memory, the same storage.
  useCartStore.setState({ lines: [] })
  storage.set('ms_cart', saved!)
  await useCartStore.persist.rehydrate()
  assert.equal(stateOf(BASO).qty, 2)
  assert.equal(stateOf(TEH).qty, 1)
})

test('checkout payload is unchanged: the card line is a plain item', () => {
  tapAdd(BASO)
  tapAdd(BASO)
  assert.deepEqual(toCheckoutItems(cart().lines), [{ product_id: 'baso', qty: 2 }])
})

test('product card wires the counter to the shared store', () => {
  const card = readFileSync(join(import.meta.dirname, '..', '..', 'components/storefront/product-card.tsx'), 'utf8').replace(/\s+/g, ' ')
  assert.match(card, /const cartState = cardCartState\(lines, product\.id, product\.availableStock\)/)
  assert.match(card, /onClick=\{\(\) => setQty\(plainLineId\(product\.id\), cartState\.qty - 1\)\}/)
  assert.match(card, /disabled=\{!cartState\.canIncrement\} onClick=\{\(\) => add\(product\)\}/)
  assert.match(card, /\{cartState\.mode === 'counter' \? \(/)
  assert.doesNotMatch(card, /useState/, 'no second quantity state')
})
