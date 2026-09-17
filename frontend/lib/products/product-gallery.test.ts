import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canGoNext,
  canGoPrevious,
  galleryImages,
  hasCarouselControls,
  imageLoading,
  nextIndex,
  previousIndex,
  slideLabel,
  thumbnailLabel,
  thumbnailTarget,
} from './product-gallery.ts'

/**
 * P2 — storefront product gallery. No component-render harness exists in this
 * package, so the behaviour lives in pure helpers (tested directly) and the markup
 * that matters for accessibility/performance is pinned in the source. Real swipe
 * and keyboard behaviour come from the shared Embla carousel and are checked in a
 * browser.
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'))
const GALLERY = read('components/storefront/product-gallery.tsx')
const FALLBACK = read('components/common/image-with-fallback.tsx')
const PAGE = read('app/catalog/[slug]/page.tsx')

const img = (id: string, sortOrder: number) => ({ id, url: `https://api.test/uploads/${id}.jpg`, sortOrder })

test('zero gallery images: falls back to Product.imageUrl (older API / no rows)', () => {
  assert.deepEqual(galleryImages({ imageUrl: '/products/baso-keju.jpg', images: [] }), [{ key: 'cover', url: '/products/baso-keju.jpg' }])
  assert.deepEqual(galleryImages({ imageUrl: '/products/baso-keju.jpg' }), [{ key: 'cover', url: '/products/baso-keju.jpg' }])
  assert.deepEqual(galleryImages({ imageUrl: '', images: [] }), [])
})

test('gallery images come in sortOrder, cover first, keyed by id', () => {
  assert.deepEqual(galleryImages({ imageUrl: 'x', images: [img('b', 1), img('c', 2), img('a', 0)] }).map((i) => i.key), ['a', 'b', 'c'])
})

test('one image: no carousel controls; two or more: controls and thumbnails', () => {
  assert.equal(hasCarouselControls(0), false)
  assert.equal(hasCarouselControls(1), false)
  assert.equal(hasCarouselControls(2), true)
  assert.equal(hasCarouselControls(8), true)
})

test('previous/next are clamped to the ends (no loop)', () => {
  assert.equal(nextIndex(0, 3), 1)
  assert.equal(nextIndex(2, 3), 2)
  assert.equal(previousIndex(2, 3), 1)
  assert.equal(previousIndex(0, 3), 0)
  assert.equal(nextIndex(9, 3), 2)
  assert.equal(previousIndex(0, 0), 0)
  assert.equal(canGoPrevious(0), false)
  assert.equal(canGoPrevious(1), true)
  assert.equal(canGoNext(1, 3), true)
  assert.equal(canGoNext(2, 3), false)
})

test('thumbnails jump to their own index (clamped)', () => {
  assert.equal(thumbnailTarget(2, 4), 2)
  assert.equal(thumbnailTarget(7, 4), 3)
  assert.equal(thumbnailTarget(-1, 4), 0)
})

test('only the cover loads eagerly; every other image is lazy', () => {
  assert.equal(imageLoading(0), 'eager')
  assert.equal(imageLoading(1), 'lazy')
  assert.equal(imageLoading(7), 'lazy')
  assert.match(GALLERY, /loading=\{imageLoading\(index\)\}/)
  assert.match(GALLERY, /alt="" loading="lazy" className="size-full object-cover"/, 'thumbnails are lazy')
})

test('alt text is the product name on every main image; thumbnails are labelled buttons', () => {
  assert.equal((GALLERY.match(/alt=\{product\.name\}/g) ?? []).length, 2, 'single-image and carousel slides')
  assert.match(GALLERY, /aria-label=\{thumbnailLabel\(product\.name, index, images\.length\)\}/)
  assert.match(GALLERY, /aria-current=\{index === selected \? 'true' : undefined\}/)
  assert.equal(thumbnailLabel('Baso Urat', 1, 3), 'Tampilkan gambar 2 dari 3: Baso Urat')
  assert.equal(slideLabel(0, 3), 'Gambar 1 dari 3')
})

test('carousel: shared Embla primitive, focusable labelled region, controls inside the frame with labels', () => {
  assert.match(GALLERY, /from '@\/components\/ui\/carousel'/)
  assert.match(GALLERY, /<Carousel setApi=\{setApi\} opts=\{\{ loop: false \}\} tabIndex=\{0\} aria-label=\{`Galeri foto \$\{product\.name\}`\}/)
  assert.match(GALLERY, /<CarouselPrevious className="left-3 bg-background\/80" aria-label="Gambar sebelumnya" \/>/)
  assert.match(GALLERY, /<CarouselNext className="right-3 bg-background\/80" aria-label="Gambar berikutnya" \/>/)
  assert.match(GALLERY, /api\?\.scrollTo\(thumbnailTarget\(index, images\.length\)\)/)
  assert.match(GALLERY, /if \(!hasCarouselControls\(images\.length\)\) \{/, 'single image renders without controls')
})

test('image error: a neutral internal placeholder with the same accessible name, no catalogue asset', () => {
  assert.match(FALLBACK, /onError=\{\(\) => setFailed\(true\)\}/)
  assert.match(FALLBACK, /role="img"\s+aria-label=\{alt\}/)
  assert.match(FALLBACK, /<ImageOff /)
  assert.equal(/\/products\//.test(FALLBACK), false)
  assert.match(GALLERY, /<ImageWithFallback /)
})

test('product page: gallery replaces the single <img>; badges stay over the image; ProductCard untouched', () => {
  assert.match(PAGE, /<ProductGallery\s+product=\{product\}\s+overlay=\{/)
  for (const badge of ['Best seller', 'variant="secondary">New', 'variant="destructive">-{discount}%']) assert.ok(PAGE.includes(badge), badge)
  assert.equal(/<img /.test(PAGE), false)
  const card = read('components/storefront/product-card.tsx')
  assert.match(card, /<img src=\{product\.imageUrl\} alt=\{product\.name\} className="absolute inset-0 size-full object-cover" \/>/)
})

test('BannerCarousel and PromoCarousel do not use the gallery or the shared primitive', () => {
  for (const file of ['components/storefront/banner-carousel.tsx', 'components/storefront/promo-carousel.tsx']) {
    const src = read(file)
    assert.equal(/product-gallery|components\/ui\/carousel/.test(src), false, file)
  }
})
