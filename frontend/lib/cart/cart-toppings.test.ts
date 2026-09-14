import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P0-1 — toppings reach the cart and the order as `topping_ids`.
 *
 * Backend contract (orders.service getCartPricing / CheckoutItemDto): each item may
 * carry `topping_ids: string[]`; the line is priced (product.price + sum of topping
 * prices) x qty; a topping that is inactive/deleted rejects the order with 400. So
 * the cart must: keep the chosen toppings ON the line, send their ids (deduped), and
 * show the same per-line formula. Same product + different toppings = two lines.
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
const {
  useCartStore, cartSubtotal, cartCount, lineUnitPrice, lineTotal, selectedSubtotal, toCheckoutItems,
  normalizeCartLines, cartLineId, toppingsTotal,
} = await import('../stores/cart-store.ts')

type AddArg = Parameters<ReturnType<typeof useCartStore.getState>['add']>[0]
const product = (id: string, price: number) =>
  ({ id, slug: `slug-${id}`, name: `Product ${id}`, price, imageUrl: `/${id}.jpg` }) as AddArg
const BASO = product('baso', 45_000)
const TEH = product('teh', 8_000)
// As GET /catalog/toppings returns them (isActive is always true there).
const KEJU = { id: 't-keju', name: 'Keju', price: 5_000, isActive: true }
const TELUR = { id: 't-telur', name: 'Telur', price: 3_000, isActive: true }

const cart = () => useCartStore.getState()
const line = (lineId: string) => cart().lines.find((l) => l.lineId === lineId)!
const COMBO = cartLineId('baso', [KEJU, TELUR]) // 'baso+t-keju,t-telur'

beforeEach(() => {
  cart().clear()
})

test('a plain product keeps lineId === productId (carts from before toppings stay valid)', () => {
  cart().add(BASO, 1)
  assert.equal(cart().lines[0].lineId, 'baso')
  assert.deepEqual(cart().lines[0].toppings, [])
})

test('chosen toppings are stored on the line with name + price; the id is product + sorted topping ids', () => {
  cart().add(BASO, 2, [TELUR, KEJU])
  const l = line(COMBO)
  assert.equal(COMBO, 'baso+t-keju,t-telur')
  assert.deepEqual(l.toppings, [
    { id: 't-keju', name: 'Keju', price: 5_000 },
    { id: 't-telur', name: 'Telur', price: 3_000 },
  ])
  assert.equal('isActive' in l.toppings[0], false, 'only what the cart needs is kept')
})

test('the same product with different toppings is a separate line; the same combo merges', () => {
  cart().add(BASO, 1)
  cart().add(BASO, 1, [KEJU])
  cart().add(BASO, 2, [KEJU, TELUR])
  cart().add(BASO, 1, [TELUR, KEJU, KEJU]) // same set, other order + a duplicate
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty]), [
    ['baso', 1],
    ['baso+t-keju', 1],
    [COMBO, 3],
  ])
  assert.equal(cartCount(cart().lines), 5)
})

test('totals include toppings: unit = product + toppings, line = unit x qty (the backend formula)', () => {
  cart().add(BASO, 2, [KEJU, TELUR]) // (45 000 + 5 000 + 3 000) x 2 = 106 000
  cart().add(BASO, 1) //                  45 000
  cart().add(TEH, 3) //                   24 000
  assert.equal(lineUnitPrice(line(COMBO)), 53_000)
  assert.equal(lineTotal(line(COMBO)), 106_000)
  assert.equal(toppingsTotal([KEJU, TELUR]), 8_000)
  assert.equal(cartSubtotal(cart().lines), 106_000 + 45_000 + 24_000)
  assert.equal(selectedSubtotal(cart().lines), 175_000)
})

test('checkout payload: topping_ids for lines with toppings; plain lines keep the exact old shape', () => {
  cart().add(BASO, 2, [TELUR, KEJU, TELUR])
  cart().add(BASO, 1)
  cart().add(TEH, 1)
  assert.deepEqual(toCheckoutItems(cart().lines), [
    { product_id: 'baso', qty: 2, topping_ids: ['t-keju', 't-telur'] }, // deduped: the backend would count a duplicate twice
    { product_id: 'baso', qty: 1 },
    { product_id: 'teh', qty: 1 },
  ])
  assert.equal(JSON.stringify(toCheckoutItems(cart().lines)).includes('price'), false, 'never a price - the server reprices')
})

test('quantity changes keep the toppings, and only touch that line', () => {
  cart().add(BASO, 1)
  cart().add(BASO, 1, [KEJU, TELUR])
  cart().setQty(COMBO, 4)
  assert.equal(line(COMBO).qty, 4)
  assert.deepEqual(line(COMBO).toppings.map((t) => t.id), ['t-keju', 't-telur'])
  assert.equal(line('baso').qty, 1, 'the plain line of the same product is untouched')
  cart().setQty(COMBO, 3) // decrease
  assert.deepEqual(toCheckoutItems(cart().lines)[1], { product_id: 'baso', qty: 3, topping_ids: ['t-keju', 't-telur'] })
})

test('select / remove act on one line: a plain "Baso" and "Baso + toppings" are independent', () => {
  cart().add(BASO, 1)
  cart().add(BASO, 1, [KEJU])
  cart().setSelected('baso', false)
  assert.deepEqual(toCheckoutItems(cart().lines), [{ product_id: 'baso', qty: 1, topping_ids: ['t-keju'] }])
  cart().remove('baso+t-keju')
  assert.deepEqual(cart().lines.map((l) => l.lineId), ['baso'])
  cart().setQty('baso', 0)
  assert.deepEqual(cart().lines, [])
})

test('after an order only the purchased lines go - by line, not by product id', () => {
  cart().add(BASO, 1)
  cart().add(BASO, 2, [KEJU, TELUR])
  cart().setSelected('baso', false) // buying only the topping line
  const purchased = cart().lines.filter((l) => l.selected).map((l) => l.lineId)
  cart().removeLines(purchased)
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty, l.selected]), [['baso', 1, false]])
})

test('toppings survive a refresh exactly (persisted under ms_cart, rehydrated)', async () => {
  cart().add(BASO, 2, [KEJU, TELUR])
  cart().add(TEH, 1)
  const saved = storage.get('ms_cart')!
  useCartStore.setState({ lines: [] })
  storage.set('ms_cart', saved)
  await useCartStore.persist.rehydrate()
  assert.deepEqual(toCheckoutItems(cart().lines), [
    { product_id: 'baso', qty: 2, topping_ids: ['t-keju', 't-telur'] },
    { product_id: 'teh', qty: 1 },
  ])
  assert.equal(cartSubtotal(cart().lines), 106_000 + 8_000)
})

test('hydration: pre-topping lines become plain lines; bad toppings drop the line; the id is re-derived', () => {
  const lines = normalizeCartLines([
    { productId: 'old', slug: 'o', name: 'Old', price: 10, imageUrl: '/o', qty: 1 }, // saved before toppings
    { productId: 'b', slug: 'b', name: 'B', price: 10, imageUrl: '/b', qty: 1, lineId: 'forged', toppings: [KEJU] },
    { productId: 'b', slug: 'b', name: 'B dup', price: 10, imageUrl: '/b', qty: 9, toppings: [{ ...KEJU }] }, // same line
    { productId: 'c', slug: 'c', name: 'C', price: 10, imageUrl: '/c', qty: 1, toppings: [{ id: 't-x', name: 'X', price: -1 }] },
    { productId: 'd', slug: 'd', name: 'D', price: 10, imageUrl: '/d', qty: 1, toppings: 'keju' },
  ])
  assert.deepEqual(lines.map((l) => [l.lineId, l.qty, l.toppings.map((t) => t.id)]), [
    ['old', 1, []],
    ['b+t-keju', 1, ['t-keju']],
  ])
})

test('quick add (product card) is unchanged: no toppings argument -> a plain line', () => {
  cart().add(TEH)
  cart().add(TEH)
  assert.deepEqual(cart().lines.map((l) => [l.lineId, l.qty, l.toppings.length]), [['teh', 2, 0]])
})

// ------------------------------------------------------------- UI wiring --

const ROOT = join(import.meta.dirname, '..', '..')
const strip = (s: string) => s.replace(/\s+/g, ' ')
const read = (rel: string) => strip(readFileSync(join(ROOT, rel), 'utf8'))

test('product page: selector from the active-toppings endpoint, name + price, hidden when there are none', () => {
  const page = read('app/catalog/[slug]/page.tsx')
  assert.match(page, /const toppingsQuery = useToppings\(\)/)
  assert.match(page, /const chosenToppings = availableToppings\.filter\(\(t\) => toppingIds\.includes\(t\.id\)\)/)
  assert.match(page, /\{!outOfStock && availableToppings\.length > 0 \? \( <fieldset>/, 'no selector while loading, on error, or with no toppings')
  assert.match(page, /<span className="flex-1 font-medium">\{topping\.name\}<\/span>/)
  assert.match(page, /\+\{formatIDR\(topping\.price\)\}/)
  assert.match(page, /add\(product, qty, chosenToppings\)/)
  assert.match(page, /const unitPrice = \(product\?\.price \?\? 0\) \+ toppingsTotal\(chosenToppings\)/)
  assert.match(page, /`Add to cart · \$\{formatIDR\(unitPrice \* qty\)\}`/)
  const hooks = read('lib/query/hooks/use-products.ts')
  assert.match(hooks, /queryKey: qk\.catalog\.toppings, queryFn: \(\) => productsApi\.toppings\(\)/)
  assert.match(read('lib/api/products.api.ts'), /toppings: \(\) => api\.get<Topping\[\]>\('\/catalog\/toppings'\)/)
})

test('cart and checkout show each line\'s toppings and price them per line', () => {
  for (const file of ['app/cart/page.tsx', 'app/checkout/page.tsx']) {
    const page = read(file)
    assert.match(page, /line\.toppings\.map\(\(t\) => `\$\{t\.name\} \(\$\{formatIDR\(t\.price\)\}\)`\)/, file)
    assert.match(page, /formatIDR\(lineUnitPrice\(line\)\)\} each/, file)
    assert.match(page, /formatIDR\(lineTotal\(line\)\)/, file)
    assert.match(page, /key=\{line\.lineId\}/, file)
    assert.doesNotMatch(page, /line\.price \* line\.qty/, `${file}: the base price alone would drop the toppings`)
  }
})
