import { BadRequestException } from '@nestjs/common';
import { isProductImageUploadUrl, MAX_PRODUCT_IMAGES } from '../upload/product-image-url';

/**
 * P2 product image gallery - the rules the admin API applies to a submitted
 * `images[]`. Pure: no Prisma, no I/O.
 *
 * - The list is the COMPLETE, ORDERED gallery: 1..8 urls, no duplicates.
 * - sortOrder is derived from the position (0..N-1); the client never sends one.
 * - images[0] is the cover and becomes Product.imageUrl.
 * - A NEW url must be an app-owned upload (isProductImageUploadUrl). A url the
 *   product ALREADY has (its current imageUrl or an existing gallery image) is kept
 *   as-is, so a legacy /products/*.jpg cover never has to be re-uploaded.
 */

/** Ordered gallery read by the admin edit form and the public product detail. */
export const ORDERED_PRODUCT_IMAGES = {
  orderBy: { sortOrder: 'asc' as const },
  select: { id: true, url: true, sortOrder: true },
};

export function assertProductImageList(images: readonly string[], alreadyOnProduct: ReadonlySet<string> = new Set()): string[] {
  if (images.length === 0) {
    throw new BadRequestException('images must contain at least one image (the first one is the product cover)');
  }
  if (images.length > MAX_PRODUCT_IMAGES) {
    throw new BadRequestException(`images must contain at most ${MAX_PRODUCT_IMAGES} images`);
  }
  if (new Set(images).size !== images.length) {
    throw new BadRequestException('images must not contain the same image twice');
  }
  images.forEach((url, index) => {
    if (alreadyOnProduct.has(url)) return;
    if (!isProductImageUploadUrl(url)) {
      throw new BadRequestException(`images[${index}] must be an image uploaded through this application (/uploads/...)`);
    }
  });
  return [...images];
}

/** A submitted `imageUrl` next to `images[]` must name the same cover - never a silent divergence. */
export function assertCoverMatches(imageUrl: string | undefined, gallery: readonly string[]): void {
  if (imageUrl !== undefined && imageUrl !== gallery[0]) {
    throw new BadRequestException('imageUrl must equal images[0] (the cover) when both are sent');
  }
}

/** Rows for a gallery, sortOrder by position. */
export function galleryRows(urls: readonly string[]): Array<{ url: string; sortOrder: number }> {
  return urls.map((url, sortOrder) => ({ url, sortOrder }));
}

/** True when the stored gallery already is exactly this ordered list (nothing to rewrite). */
export function sameGallery(stored: ReadonlyArray<{ url: string; sortOrder: number }>, urls: readonly string[]): boolean {
  const ordered = [...stored].sort((a, b) => a.sortOrder - b.sortOrder);
  return ordered.length === urls.length && ordered.every((image, i) => image.sortOrder === i && image.url === urls[i]);
}
