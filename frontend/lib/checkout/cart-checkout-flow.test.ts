import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #6 — Cart page and Checkout wiring for partial checkout.
 *
 * Before: the cart had no selection, Checkout mapped EVERY cart line into the order
 * (`lines.map(...)`) and emptied the whole cart on success (`clearCart()`).
 *
 * No component-render harness exists in this package, so this pins the wiring in
 * the source; the selection rules themselves are exercised against the real store in
 * lib/cart/cart-selection.test.ts, and the rendered flow is verified in the browser.
 */

const strip = (src: string) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CART = strip(readFileSync(join(process.cwd(), 'app/cart/page.tsx'), 'utf8'))
const CHECKOUT = strip(readFileSync(join(process.cwd(), 'app/checkout/page.tsx'), 'utf8'))

// --------------------------------------------------------------------- Cart ---

test('every cart line has its own accessible checkbox bound to its selection', () => {
  const perLine = CART.split('{lines.map((line) => (')[1] ?? ''
  assert.match(perLine, /<Checkbox[\s\S]*?checked=\{line\.selected\}/)
  assert.match(perLine, /onCheckedChange=\{\(checked\) => setSelected\(line\.productId, checked === true\)\}/)
  assert.match(perLine, /aria-label=\{`Select \$\{line\.name\}`\}/)
})

test('Select all / Unselect all is one labelled checkbox over every line', () => {
  assert.match(CART, /const allSelected = lines\.length > 0 && selectedCount === lines\.length/)
  assert.match(CART, /id="cart-select-all"\s*checked=\{allSelected\}\s*onCheckedChange=\{\(checked\) => setAllSelected\(checked === true\)\}/)
  assert.match(CART, /<label htmlFor="cart-select-all"[^>]*>\s*Select all\s*<\/label>/)
})

test('the summary shows the SELECTED subtotal, not the whole cart', () => {
  assert.match(CART, /const subtotal = selectedSubtotal\(lines\)/)
  assert.equal(/cartSubtotal\(/.test(CART), false)
  assert.match(CART, /Subtotal \(\{selectedCount\} of \{lines\.length\} items\)/)
})

test('8. with nothing selected the checkout button is disabled and says why', () => {
  const summary = CART.split('{selectedCount > 0 ? (')[1] ?? ''
  assert.ok(summary, 'checkout button must depend on the selection')
  const [enabled, disabled] = summary.split(') : (')
  assert.match(enabled, /<Link href="\/checkout">/)
  assert.match(disabled, /<Button size="lg" className="w-full rounded-full" disabled>/)
  assert.equal(/href="\/checkout"/.test(disabled.split('</Card>')[0]), false, 'no checkout link when nothing is selected')
  assert.match(disabled, /Select at least one item to check out\./)
})

test('existing cart behaviour is kept: quantity, remove, navigation, clear, empty state', () => {
  assert.match(CART, /setQty\(line\.productId, line\.qty - 1\)/)
  assert.match(CART, /setQty\(line\.productId, line\.qty \+ 1\)/)
  assert.match(CART, /onClick=\{\(\) => remove\(line\.productId\)\}/)
  assert.match(CART, /<Link href=\{`\/catalog\/\$\{line\.slug\}`\}/)
  assert.match(CART, /formatIDR\(line\.price\)\} each/)
  assert.match(CART, /formatIDR\(line\.price \* line\.qty\)/)
  assert.match(CART, /onClick=\{\(\) => clear\(\)\}/)
  assert.match(CART, /if \(lines\.length === 0\) \{[\s\S]*?title="Your cart is empty"/)
})

// ----------------------------------------------------------------- Checkout ---

test('9. Checkout builds the order from the explicit selected subset only', () => {
  assert.match(CHECKOUT, /const checkoutLines = useMemo\(\(\) => selectedLines\(lines\), \[lines\]\)/)
  assert.match(CHECKOUT, /const checkoutItems = useMemo\(\(\) => toCheckoutItems\(lines\), \[lines\]\)/)
  assert.equal(/lines\.map\(\(l\) => \(\{ product_id/.test(CHECKOUT), false, 'no whole-cart mapping left')
  // One list for quotes, the summary and the order.
  assert.match(CHECKOUT, /useShippingOptions\(selectedAddressId, checkoutItems, deliverable\)/)
  assert.match(CHECKOUT, /items: checkoutItems,\s*enabled: canPlaceOrder/)
  assert.match(CHECKOUT, /voucher_code: values\.voucher_code \|\| undefined,\s*items: checkoutItems,/)
  // What the customer sees is what is ordered.
  assert.match(CHECKOUT, /Order \(\{checkoutLines\.length\} items\)/)
  assert.match(CHECKOUT, /\{checkoutLines\.map\(\(line\) => \(/)
})

test('8. nothing selected: Checkout shows a clear message and never falls back to the cart', () => {
  const guard = CHECKOUT.indexOf('if (checkoutLines.length === 0) {')
  assert.ok(guard > 0)
  assert.ok(guard < CHECKOUT.indexOf('<form onSubmit'), 'the form (and its submit) is never rendered without a selection')
  assert.match(CHECKOUT.slice(guard), /title="No items selected"[\s\S]*?<Link href="\/cart">Back to cart<\/Link>/)
  assert.match(CHECKOUT, /if \(!selectedShipping \|\| checkoutItems\.length === 0\) return/)
  // The empty-cart state is unchanged and comes first.
  assert.ok(CHECKOUT.indexOf('if (lines.length === 0) {') < guard)
})

test('10/11. success removes only the purchased lines; nothing else ever removes cart lines', () => {
  assert.match(CHECKOUT, /const purchasedIds = input\.items\.map\(\(item\) => item\.product_id\)/)
  const success = CHECKOUT.split('onSuccess: (order) => {')[1]?.split('router.push')[0] ?? ''
  assert.match(success, /removeLines\(purchasedIds\)/)
  assert.equal(/clearCart|\.clear\(\)/.test(CHECKOUT.replace('clearChosenAddress()', '')), false, 'the whole cart is never cleared')
  // Abandoning checkout (leaving, refresh, error) cannot delete anything: the only
  // removal is inside onSuccess.
  assert.equal((CHECKOUT.match(/removeLines\(/g) ?? []).length, 1)
})

test('the unselected items are visibly kept, with a way back to change the selection', () => {
  assert.match(CHECKOUT, /const unselectedCount = lines\.length - checkoutLines\.length/)
  assert.match(CHECKOUT, /\{unselectedCount > 0 \? \([\s\S]*?in your cart[\s\S]*?<Link href="\/cart"[^>]*>\s*Change selection/)
})

test('14. the #7/#17/#18 address flow is untouched by #6', () => {
  assert.match(CHECKOUT, /resolveCheckoutAddressId\(addresses, chosenAddressId\)/)
  assert.match(CHECKOUT, /<Link href=\{ADDRESS_BOOK_FROM_CHECKOUT\}>Change address<\/Link>/)
  assert.match(CHECKOUT, /onSuccess: onAddressCreated/)
  const success = CHECKOUT.split('onSuccess: (order) => {')[1]?.split('router.push')[0] ?? ''
  assert.match(success, /clearChosenAddress\(\)/)
})
