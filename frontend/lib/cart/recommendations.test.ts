import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickRecommendations, RECOMMENDATION_LIMIT } from './recommendations.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ')

const p = (id: string, availableStock = 5) => ({ id, availableStock })

test('keeps the server (best-selling) order and stops at the limit', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => p(id))
  assert.deepEqual(pickRecommendations(ranked, []).map((x) => x.id), ['a', 'b', 'c', 'd'])
  assert.equal(RECOMMENDATION_LIMIT, 4)
  assert.deepEqual(pickRecommendations(ranked, [], 2).map((x) => x.id), ['a', 'b'])
})

test('skips products already in the cart and sold-out ones, then fills from the next ranked', () => {
  const ranked = [p('a'), p('b', 0), p('c'), p('d'), p('e'), p('f')]
  assert.deepEqual(pickRecommendations(ranked, ['a', 'd']).map((x) => x.id), ['c', 'e', 'f'])
})

test('never invents items: fewer (or none) when the catalog has fewer to offer', () => {
  assert.deepEqual(pickRecommendations([], ['a']), [])
  assert.deepEqual(pickRecommendations([p('a')], ['a']), [])
  assert.deepEqual(pickRecommendations([p('x', Number.NaN)], []), [])
})

test('cart page: "Tambah Pesanan" links to the catalog and replaces "Hapus semua"', () => {
  const page = read('app/cart/page.tsx')
  assert.match(page, /<Link href="\/catalog"> <Plus className="mr-1 size-4" \/> Tambah Pesanan <\/Link>/)
  assert.doesNotMatch(page, /Hapus semua/i)
  assert.doesNotMatch(page, /clear\(\)/, 'the cart is no longer emptied from this button')
})

test('cart page: "Rekomendasi Menu Lain" comes from the best-selling catalog sort, minus the cart', () => {
  const page = read('app/cart/page.tsx')
  assert.match(page, /useProducts\(\{ sort: 'best-selling' \}\)/)
  assert.match(page, /pickRecommendations\(bestSellingQuery\.data \?\? \[\], lines\.map\(\(l\) => l\.productId\)\)/)
  assert.match(page, /<ProductSection title="Rekomendasi Menu Lain" products=\{recommendations\}/)
  assert.match(read('lib/api/products.api.ts'), /sort\?: 'popular' \| 'price-low' \| 'price-high' \| 'rating' \| 'best-selling'/)
})
