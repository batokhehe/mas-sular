import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESS_BOOK_FROM_CHECKOUT,
  CHECKOUT_PATH,
  RETURN_PARAM,
  resolveCheckoutAddressId,
  safeAddressBookReturn,
} from './checkout-address.ts'

// A minimal per-tab sessionStorage (Node has none) so the store's persistence runs for real.
const tab = new Map<string, string>()
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => void tab.set(k, v),
    removeItem: (k: string) => void tab.delete(k),
  },
})
const { useCheckoutAddressStore } = await import('../stores/checkout-address-store.ts')

/**
 * P2 #7 / #17 / #18 — which address Checkout uses, and where the Address Book may
 * send the customer back to.
 */

const home = { id: 'a-home', isDefault: true }
const office = { id: 'a-office', isDefault: false }
const kos = { id: 'a-kos', isDefault: false }

test('#7 the default (primary) address is selected when the customer has not chosen one', () => {
  assert.equal(resolveCheckoutAddressId([office, home, kos], null), 'a-home')
  assert.equal(resolveCheckoutAddressId([office, home, kos], undefined), 'a-home')
})

test('#7 several addresses and no default: nothing is picked for the customer', () => {
  assert.equal(resolveCheckoutAddressId([office, kos], null), null)
  assert.equal(resolveCheckoutAddressId([kos, office], null), null, 'list order must not decide')
})

test('#7 a single address (no default) is the only possible choice, so it is used', () => {
  assert.equal(resolveCheckoutAddressId([office], null), 'a-office')
})

test('#7 zero addresses: nothing to select', () => {
  assert.equal(resolveCheckoutAddressId([], null), null)
  assert.equal(resolveCheckoutAddressId([], 'a-home'), null)
})

test('#18 a deliberately chosen non-default address stays selected (no revert to primary)', () => {
  assert.equal(resolveCheckoutAddressId([home, office, kos], 'a-kos'), 'a-kos')
  // ...also when it is a new address that is not the default.
  assert.equal(resolveCheckoutAddressId([home, office, kos, { id: 'a-new', isDefault: false }], 'a-new'), 'a-new')
})

test('a stored choice that is not one of THIS customer\'s addresses is ignored', () => {
  // Deleted address, or another customer's id left in the same browser tab.
  assert.equal(resolveCheckoutAddressId([home, office], 'someone-elses-id'), 'a-home')
  assert.equal(resolveCheckoutAddressId([office, kos], 'deleted-id'), null)
})

test('#17 Checkout links to the Address Book with an allowlisted return target', () => {
  const url = new URL(ADDRESS_BOOK_FROM_CHECKOUT, 'http://localhost')
  assert.equal(url.pathname, '/account/addresses')
  assert.equal(safeAddressBookReturn(url.searchParams.get(RETURN_PARAM)), CHECKOUT_PATH)
})

test('#17 only the exact internal Checkout path is a valid return target (no open redirect)', () => {
  assert.equal(safeAddressBookReturn('/checkout'), '/checkout')
  for (const hostile of [
    null,
    undefined,
    '',
    'https://evil.example/checkout',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,hi',
    '/checkout?next=https://evil.example',
    '/checkout/../admin',
    '/checkout#x',
    ' /checkout',
    '/CHECKOUT',
    '/account',
    '/',
  ]) {
    assert.equal(safeAddressBookReturn(hostile), null, `must reject ${String(hostile)}`)
  }
})

test('the checkout-address store keeps a choice (in this tab\'s sessionStorage) until it is cleared', () => {
  const store = useCheckoutAddressStore
  const persisted = () => JSON.parse(tab.get('ms_checkout_address') ?? 'null')?.state?.addressId ?? null
  store.getState().clear()
  assert.equal(store.getState().addressId, null)
  store.getState().choose('a-kos')
  assert.equal(store.getState().addressId, 'a-kos')
  assert.equal(persisted(), 'a-kos', 'survives the Address Book navigation and a refresh')
  store.getState().choose('a-office')
  assert.equal(store.getState().addressId, 'a-office', 'a later choice replaces an earlier one')
  store.getState().clear()
  assert.equal(store.getState().addressId, null)
  assert.equal(persisted(), null, 'cleared after an order is placed')
  // Only an id is kept - no address details (PII) are written to storage.
  assert.deepEqual(Object.keys(JSON.parse(tab.get('ms_checkout_address') ?? '{}').state), ['addressId'])
})
