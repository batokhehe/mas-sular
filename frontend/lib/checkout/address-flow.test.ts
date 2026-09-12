import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #7 / #17 / #18 — Checkout ↔ Address Book wiring.
 *
 * Found before the fix (browser, customer with a default address): Checkout opened
 * with NO address selected. The preselect effect did set the default, but Radix
 * Select's hidden native <select> then reported '' while its options mounted, and
 * `onValueChange={field.onChange}` stored that '' over it. The choice was also form
 * state only, so any trip to the Address Book lost it; the Address Book had no way
 * back, and a customer without addresses was sent there with no return path.
 *
 * No component-render harness exists in this package, so this pins the wiring in
 * the source; the rendered flow is verified in the browser (see the report). The
 * selection rules and the redirect allowlist are unit-tested in
 * lib/address/checkout-address.test.ts.
 */

const strip = (src: string) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CHECKOUT = strip(readFileSync(join(process.cwd(), 'app/checkout/page.tsx'), 'utf8'))
const BOOK = strip(readFileSync(join(process.cwd(), 'app/account/addresses/page.tsx'), 'utf8'))

// ---------------------------------------------------------------- Checkout ---

test('#7 Checkout preselects via the shared rule (choice > default > only), not addresses[0]', () => {
  assert.match(CHECKOUT, /resolveCheckoutAddressId\(addresses, chosenAddressId\)/)
  assert.equal(/\?\?\s*addresses\[0\]/.test(CHECKOUT), false, 'no arbitrary first-address fallback')
  // Only while nothing is selected - never overrides a choice made on the page.
  assert.match(CHECKOUT, /if \(addresses\.length > 0 && !getValues\('address_id'\)\)/)
})

test('#7 the empty value Radix reports while mounting can no longer wipe the selection', () => {
  const handler = (CHECKOUT.match(/onValueChange=\{\(id\) => \{([\s\S]*?)\}\}/) ?? [])[1] ?? ''
  assert.ok(handler, 'address <Select> needs its own onValueChange handler')
  const guard = handler.indexOf('if (!id) return')
  assert.ok(guard >= 0, 'empty values must be ignored')
  assert.ok(guard < handler.indexOf('field.onChange(id)'), 'guard must run before the form value changes')
  assert.equal(/onValueChange=\{field\.onChange\}/.test(CHECKOUT.split('name="address_id"')[1]?.split('</Select>')[0] ?? ''), false)
})

test('#18 picking an address on Checkout records it as the customer\'s choice', () => {
  const handler = (CHECKOUT.match(/onValueChange=\{\(id\) => \{([\s\S]*?)\}\}/) ?? [])[1] ?? ''
  assert.match(handler, /field\.onChange\(id\)\s*chooseAddress\(id\)/)
})

test('#18 Checkout offers Add address (in place) and Change address (Address Book, with return)', () => {
  assert.match(CHECKOUT, /<Link href=\{ADDRESS_BOOK_FROM_CHECKOUT\}>Change address<\/Link>/)
  assert.ok((CHECKOUT.match(/onClick=\{\(\) => setAddAddressOpen\(true\)\}/g) ?? []).length >= 2, 'Add address with and without saved addresses')
  // The zero-address state no longer dead-ends in the Address Book.
  assert.equal(/href="\/account\/addresses"/.test(CHECKOUT), false)
})

test('#18 a new address is selected immediately and becomes the checkout choice', () => {
  assert.match(CHECKOUT, /createAddress\.mutate\(\{ \.\.\.values, isDefault: values\.isDefault \?\? false \}, \{ onSuccess: onAddressCreated \}\)/)
  const created = (CHECKOUT.match(/const onAddressCreated = \(created: Address\) => \{([\s\S]*?)\n  \}/) ?? [])[1] ?? ''
  assert.match(created, /setValue\('address_id', created\.id/)
  assert.match(created, /chooseAddress\(created\.id\)/)
  assert.match(created, /setAddAddressOpen\(false\)/)
})

test('the Add-address form is NOT inside the checkout <form> (saving must never place the order)', () => {
  const formEnd = CHECKOUT.lastIndexOf('</form>')
  const addressForm = CHECKOUT.indexOf('<AddressForm')
  assert.ok(formEnd > 0 && addressForm > 0)
  assert.ok(addressForm > formEnd, 'a portal still bubbles React submit events to its React parents')
})

test('the order is placed with the SELECTED address id, and cannot be placed without one', () => {
  assert.match(CHECKOUT, /address_id: values\.address_id,/)
  assert.match(CHECKOUT, /address_id: z\.string\(\)\.min\(1, 'Select a delivery address'\)/)
  assert.match(CHECKOUT, /const selectedAddress = addresses\.find\(\(a\) => a\.id === selectedAddressId\)/)
  assert.match(CHECKOUT, /const canPlaceOrder = deliverable && !!selectedShipping/)
  assert.match(CHECKOUT, /disabled=\{checkout\.isPending \|\| !canPlaceOrder\}/)
})

test('after an order the stored choice is cleared (next checkout starts from the default)', () => {
  const success = CHECKOUT.split('onSuccess: (order) => {')[1]?.split('router.push')[0] ?? ''
  // P2 #6: the order's own lines leave the cart (was clearCart() - the whole cart).
  assert.match(success, /removeLines\(purchasedIds\)/)
  assert.match(success, /clearChosenAddress\(\)/)
})

test('address dialogs scroll on short phones (Save was below a 375x667 screen)', () => {
  // Measured: the AddressForm dialog is ~844px tall, fixed and non-scrolling, with
  // body scroll locked - at 667px high its Save button sat at 697-732px.
  const scrollable = /<DialogContent className="max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto">/g
  assert.equal((CHECKOUT.match(scrollable) ?? []).length, 1, 'Checkout: add')
  assert.equal((BOOK.match(scrollable) ?? []).length, 2, 'Address Book: add + edit')
})

// ------------------------------------------------------------ Address Book ---

test('#17 Back to checkout is shown ONLY for an allowlisted return target', () => {
  assert.match(BOOK, /const returnTo = safeAddressBookReturn\(useSearchParams\(\)\.get\(RETURN_PARAM\)\)/)
  assert.match(BOOK, /\{returnTo \? \(\s*<Button asChild[\s\S]*?<Link href=\{returnTo\}>[\s\S]*?Back to checkout/)
  // The raw query value never reaches navigation.
  assert.equal(/useSearchParams\(\)\.get\([^)]*\)\s*\}/.test(BOOK), false)
  assert.equal(/router\.(push|replace)|window\.location|location\.href/.test(BOOK), false)
})

test('#18 from Checkout, the Address Book lets the customer choose the delivery address', () => {
  assert.match(BOOK, /const deliveryAddressId = returnTo \? resolveCheckoutAddressId\(addresses, chosenAddressId\) : null/)
  assert.match(BOOK, /onClick=\{\(\) => chooseAddress\(address\.id\)\}/)
  assert.match(BOOK, /Selected for delivery/)
  // A new address added in that context becomes the choice; a direct visit writes nothing.
  assert.match(BOOK, /if \(returnTo\) chooseAddress\(created\.id\)/)
  assert.equal((BOOK.match(/chooseAddress\(/g) ?? []).length, 2)
})

test('#17 direct Address Book visits keep the existing CRUD behaviour', () => {
  assert.match(BOOK, /<Suspense fallback=\{null\}>\s*<AddressBook \/>\s*<\/Suspense>/)
  assert.match(BOOK, /update\.mutate\(\{ id: address\.id, body: \{ isDefault: true \} \}\)/, 'set as default')
  assert.match(BOOK, /update\.mutate\(\{ id: editing\.id, body: values \}, \{ onSuccess: \(\) => setEditing\(null\) \}\)/, 'edit')
  assert.match(BOOK, /remove\.mutate\(deleting\.id, \{ onSuccess: \(\) => setDeleting\(null\) \}\)/, 'delete')
  assert.match(BOOK, /\{ \.\.\.values, isDefault: values\.isDefault \?\? false \}/, 'create payload unchanged')
  assert.match(BOOK, /setCreateOpen\(false\)/)
})
