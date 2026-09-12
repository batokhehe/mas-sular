import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * P2 #6 — cart item selection and partial checkout (store + pure helpers).
 *
 * The cart is client-side only (zustand persisted to localStorage `ms_cart`). The
 * selection lives ON each line (`selected`), so there is no separate id list that
 * could hold stale ids. What checkout receives is `toCheckoutItems(lines)`: ids and
 * quantities of the ticked lines, never prices - the backend reprices them.
 */

// A minimal window.localStorage (Node has none; zustand's default persist storage
// reads `window.localStorage`) so persistence and rehydration run for real.
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
const { useCartStore, cartSubtotal, selectedLines, selectedSubtotal, toCheckoutItems, normalizeCartLines } =
  await import('../stores/cart-store.ts')

type AddArg = Parameters<ReturnType<typeof useCartStore.getState>['add']>[0]
const product = (id: string, price: number) =>
  ({ id, slug: `slug-${id}`, name: `Product ${id}`, price, imageUrl: `/${id}.jpg` }) as AddArg
const BASO = product('baso', 45_000)
const KEJU = product('keju', 40_000)
const TEH = product('teh', 8_000)

const cart = () => useCartStore.getState()
const ids = (lines: { productId: string }[]) => lines.map((l) => l.productId)
const persisted = () => JSON.parse(storage.get('ms_cart') ?? '{"state":{"lines":[]}}').state.lines as Array<Record<string, unknown>>

beforeEach(() => {
  cart().clear()
  cart().add(BASO, 2) // 90 000
  cart().add(KEJU, 1) // 40 000
  cart().add(TEH, 3) //  24 000
})

test('new items are added selected (the whole cart goes to checkout until the customer unticks)', () => {
  assert.deepEqual(cart().lines.map((l) => l.selected), [true, true, true])
  assert.equal(selectedSubtotal(cart().lines), 154_000)
  assert.equal(selectedSubtotal(cart().lines), cartSubtotal(cart().lines))
})

test('1. select one of several items', () => {
  cart().setAllSelected(false)
  cart().setSelected('keju', true)
  assert.deepEqual(ids(selectedLines(cart().lines)), ['keju'])
  assert.equal(selectedSubtotal(cart().lines), 40_000)
})

test('2. select multiple items', () => {
  cart().setSelected('keju', false)
  assert.deepEqual(ids(selectedLines(cart().lines)), ['baso', 'teh'])
  assert.equal(selectedSubtotal(cart().lines), 90_000 + 24_000)
})

test('3. Select All selects every line in the cart', () => {
  cart().setSelected('baso', false)
  cart().setSelected('teh', false)
  cart().setAllSelected(true)
  assert.deepEqual(ids(selectedLines(cart().lines)), ['baso', 'keju', 'teh'])
})

test('4. Unselect All clears the selection but keeps every item', () => {
  cart().setAllSelected(false)
  assert.equal(selectedLines(cart().lines).length, 0)
  assert.equal(selectedSubtotal(cart().lines), 0)
  assert.deepEqual(ids(cart().lines), ['baso', 'keju', 'teh'], 'unselecting never removes an item')
})

test('5. the selected subtotal is only selected quantity x displayed unit price', () => {
  cart().setSelected('teh', false)
  const expected = 2 * 45_000 + 1 * 40_000
  assert.equal(selectedSubtotal(cart().lines), expected)
  assert.notEqual(selectedSubtotal(cart().lines), cartSubtotal(cart().lines), 'unselected lines are excluded')
})

test('6. changing a quantity updates the selected subtotal - and keeps the selection', () => {
  cart().setSelected('teh', false)
  cart().setQty('baso', 5)
  assert.equal(selectedSubtotal(cart().lines), 5 * 45_000 + 40_000)
  cart().setQty('teh', 10) // unselected: no effect on the selected subtotal
  assert.equal(selectedSubtotal(cart().lines), 5 * 45_000 + 40_000)
  assert.equal(cart().lines.find((l) => l.productId === 'teh')?.selected, false)
})

test('7. removing an item removes its selection with it (no stale ids)', () => {
  cart().remove('keju')
  assert.deepEqual(ids(selectedLines(cart().lines)), ['baso', 'teh'])
  cart().setQty('baso', 0) // quantity 0 removes the line too
  assert.deepEqual(ids(cart().lines), ['teh'])
  assert.deepEqual(ids(selectedLines(cart().lines)), ['teh'])
  cart().clear()
  assert.deepEqual(cart().lines, [])
  assert.deepEqual(selectedLines(cart().lines), [], 'an empty cart has an empty selection')
})

test('9. the checkout payload holds only the selected items - ids and quantities, no prices', () => {
  cart().setSelected('keju', false)
  assert.deepEqual(toCheckoutItems(cart().lines), [
    { product_id: 'baso', qty: 2 },
    { product_id: 'teh', qty: 3 },
  ])
  cart().setAllSelected(false)
  assert.deepEqual(toCheckoutItems(cart().lines), [], 'nothing selected -> nothing to check out (never the whole cart)')
})

test('10. after an order, only the purchased lines are removed; unselected ones stay', () => {
  cart().setSelected('keju', false)
  const purchased = toCheckoutItems(cart().lines).map((i) => i.product_id)
  cart().removeLines(purchased)
  assert.deepEqual(ids(cart().lines), ['keju'])
  assert.equal(cart().lines[0].qty, 1, 'the remaining line is untouched')
  assert.equal(cart().lines[0].selected, false)
})

test('11. leaving checkout without ordering changes nothing (no action removes lines on its own)', () => {
  cart().setSelected('teh', false)
  const before = JSON.stringify(cart().lines)
  // Checkout only reads the store; building the payload must not mutate it.
  toCheckoutItems(cart().lines)
  selectedLines(cart().lines)
  assert.equal(JSON.stringify(cart().lines), before)
})

test('re-adding an unticked product ticks it again (explicit, deterministic)', () => {
  cart().setSelected('keju', false)
  cart().add(KEJU, 1)
  const keju = cart().lines.find((l) => l.productId === 'keju')!
  assert.deepEqual({ qty: keju.qty, selected: keju.selected }, { qty: 2, selected: true })
})

test('12. the selection is persisted on the lines and survives a refresh exactly', async () => {
  cart().setSelected('keju', false)
  assert.deepEqual(persisted().map((l) => [l.productId, l.selected]), [['baso', true], ['keju', false], ['teh', true]])
  // Simulate a fresh page: in-memory state gone, storage as the browser kept it.
  const saved = storage.get('ms_cart')!
  useCartStore.setState({ lines: [] })
  storage.set('ms_cart', saved)
  await useCartStore.persist.rehydrate()
  assert.deepEqual(cart().lines.map((l) => [l.productId, l.selected]), [['baso', true], ['keju', false], ['teh', true]])
  // Partial stays partial after a refresh - it never becomes a full-cart checkout.
  assert.deepEqual(ids(toCheckoutItems(cart().lines).map((i) => ({ productId: i.product_id }))), ['baso', 'teh'])
})

test('12. a cart saved before #6 (no `selected`) hydrates as fully selected - the old checkout behaviour', async () => {
  storage.set('ms_cart', JSON.stringify({ state: { lines: [
    { productId: 'baso', slug: 's', name: 'Baso', price: 45_000, imageUrl: '/b.jpg', qty: 1 },
    { productId: 'teh', slug: 't', name: 'Teh', price: 8_000, imageUrl: '/t.jpg', qty: 2 },
  ] }, version: 0 }))
  await useCartStore.persist.rehydrate()
  assert.deepEqual(cart().lines.map((l) => [l.productId, l.selected]), [['baso', true], ['teh', true]])
})

test('12. hydration drops malformed entries and duplicate ids instead of inventing a selection', () => {
  const lines = normalizeCartLines([
    { productId: 'a', slug: 'a', name: 'A', price: 1, imageUrl: '/a', qty: 1, selected: false },
    { productId: 'a', slug: 'a', name: 'A dup', price: 1, imageUrl: '/a', qty: 9, selected: true },
    { productId: 'b', slug: 'b', name: 'B', price: 1, imageUrl: '/b', qty: 0 },
    { slug: 'no-id', qty: 1 },
    null,
    'junk',
  ])
  assert.deepEqual(lines.map((l) => [l.productId, l.qty, l.selected]), [['a', 1, false]])
  assert.deepEqual(normalizeCartLines(undefined), [])
  assert.deepEqual(normalizeCartLines({ not: 'an array' }), [])
})

test('13. with every item selected, checkout gets the whole cart exactly as before #6', () => {
  assert.deepEqual(toCheckoutItems(cart().lines), cart().lines.map((l) => ({ product_id: l.productId, qty: l.qty })))
  assert.equal(selectedSubtotal(cart().lines), cartSubtotal(cart().lines))
})
