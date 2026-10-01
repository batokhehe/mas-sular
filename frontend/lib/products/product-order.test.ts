import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Canonical product ordering on the storefront. The ORDER IS THE SERVER'S: the catalog
 * API returns products in Product.sequence (set by dragging rows in the Admin) unless an
 * explicit sort is requested. Nothing here sorts products client-side, so every list
 * inherits that order automatically.
 *
 * No component-render harness exists in this package, so this pins the wiring in the
 * source; the server rules are proven in the backend product-sequence specs.
 */

const code = (src: string) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => code(readFileSync(join(process.cwd(), p), 'utf8'))
const HOME = read('app/page.tsx')
const CATALOG = read('app/catalog/page.tsx')
const DETAIL = read('app/catalog/[slug]/page.tsx')
const API = read('lib/api/products.api.ts')
const HOOK = read('lib/query/hooks/use-products.ts')
const SECTION = read('components/storefront/product-section.tsx')
const TYPES = read('lib/types/models.ts')
const BACKEND_RULE = readFileSync(join(process.cwd(), '../backend/src/modules/catalog/product-sequence.ts'), 'utf8')

test('the server owns the order: sequence ASC with a total-order tiebreak', () => {
  assert.match(
    BACKEND_RULE,
    /PRODUCT_SEQUENCE_ORDER_BY: Prisma\.ProductOrderByWithRelationInput\[\] = \[\s*\{ sequence: 'asc' \},\s*\{ createdAt: 'desc' \},\s*\{ id: 'asc' \},\s*\]/,
  )
  const REPO = readFileSync(join(process.cwd(), '../backend/src/modules/catalog/infrastructure/prisma-catalog.repository.ts'), 'utf8')
  assert.match(REPO, /: PRODUCT_SEQUENCE_ORDER_BY;/)
})

test('sequence is part of the product contract (read-only; nothing sorts by it client-side)', () => {
  assert.match(TYPES, /sequence: number/)
  for (const [name, src] of [['home', HOME], ['catalog', CATALOG], ['detail', DETAIL], ['section', SECTION]] as const) {
    assert.equal(/\.sort\(/.test(src), false, `${name} must not sort products client-side`)
    assert.equal(/sequence/.test(src), false, `${name} must not read sequence`)
  }
})

test('the homepage sections request no sort, so they come back in the canonical order', () => {
  assert.match(HOOK, /queryFn: \(\) => productsApi\.list\(query\)/)
  assert.match(HOME, /useProducts\(\{\}\)/)
  assert.match(HOME, /useProducts\(\{ promoSpecial: true \}\)/)
  assert.match(HOME, /useProducts\(\{ trialPack: true \}\)/)
  assert.equal(/useProducts\(\{[^}]*sort/.test(HOME), false)
})

test('related products on the detail page also inherit it', () => {
  assert.match(DETAIL, /useProducts\(\{ category: product\?\.category\?\.slug \}\)/)
  assert.equal(/sort/.test(DETAIL), false)
})

test('the catalog "Standar" option sends no sort; the explicit business sorts are unchanged', () => {
  assert.match(CATALOG, /sort: sort === 'default' \? undefined : sort/)
  assert.match(
    CATALOG,
    /const SORT_OPTIONS: \{ value: SortValue; label: string \}\[\] = \[\s*\{ value: 'default', label: 'Standar' \},\s*\{ value: 'popular', label: 'Paling Populer' \},\s*\{ value: 'price-low', label: 'Harga Terendah' \},\s*\{ value: 'price-high', label: 'Harga Tertinggi' \},\s*\{ value: 'rating', label: 'Rating Tertinggi' \},\s*\]/,
  )
  assert.match(API, /sort\?: 'popular' \| 'price-low' \| 'price-high' \| 'rating'/)
})

test('every control still maps to a real backend query param (no client-side filtering/sorting)', () => {
  assert.match(API, /list: \(q: ProductQuery = \{\}\) => api\.get<Product\[\]>\(`\/catalog\/products\$\{buildQuery\(q\)\}`\)/)
  assert.match(CATALOG, /const \{ data, isLoading, isError, refetch \} = useProducts\(\{/)
})
