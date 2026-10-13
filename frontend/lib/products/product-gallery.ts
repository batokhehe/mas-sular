/**
 * P2 product gallery — PURE helpers behind ProductGallery. No React, no DOM, so the
 * behaviour is unit-testable without a render harness.
 */

export interface GalleryImage {
  /** Stable React key: the image id, or a synthetic key for the imageUrl fallback. */
  key: string
  url: string
}

interface GallerySource {
  imageUrl?: string | null
  images?: ReadonlyArray<{ id: string; url: string; sortOrder: number }> | null
}

/**
 * The images to show, cover first: the product's gallery in sortOrder, or - when it
 * has none (older API, product without gallery rows) - its imageUrl alone.
 */
export function galleryImages(product: GallerySource): GalleryImage[] {
  const stored = [...(product.images ?? [])]
    .filter((image) => typeof image.url === 'string' && image.url.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((image) => ({ key: image.id, url: image.url }))
  if (stored.length > 0) return stored
  return product.imageUrl ? [{ key: 'cover', url: product.imageUrl }] : []
}

/** Prev/next buttons and thumbnails only make sense with two or more images. */
export function hasCarouselControls(count: number): boolean {
  return count > 1
}

/** No wrap-around (the carousel does not loop): clamped to the ends. */
export function previousIndex(current: number, count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(current, count - 1) - 1)
}

export function nextIndex(current: number, count: number): number {
  return count <= 0 ? 0 : Math.min(count - 1, Math.max(current, 0) + 1)
}

export function canGoPrevious(current: number): boolean {
  return current > 0
}

export function canGoNext(current: number, count: number): boolean {
  return current < count - 1
}

/** A thumbnail click jumps to its own index (clamped into range). */
export function thumbnailTarget(index: number, count: number): number {
  return count <= 0 ? 0 : Math.max(0, Math.min(index, count - 1))
}

/** The first (cover) image loads eagerly; every other image is lazy. */
export function imageLoading(index: number): 'eager' | 'lazy' {
  return index === 0 ? 'eager' : 'lazy'
}

/** Accessible names — the product name is the alt text of every image. */
export function slideLabel(index: number, count: number): string {
  return `Gambar ${index + 1} dari ${count}`
}

export function thumbnailLabel(productName: string, index: number, count: number): string {
  return `Tampilkan gambar ${index + 1} dari ${count}: ${productName}`
}
