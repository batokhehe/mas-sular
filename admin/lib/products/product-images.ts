/**
 * P2 product image gallery — PURE helpers behind the product form. No React, no
 * fetch: the uploader is injected, so every rule is unit-testable.
 *
 * The list is ordered; index 0 is the cover (it becomes Product.imageUrl on save).
 * Removing an image only removes it from the product - the uploaded file is kept.
 */

export const MAX_PRODUCT_IMAGES = 8;

type ProductImagesSource = {
  imageUrl?: string | null;
  images?: ReadonlyArray<{ url: string; sortOrder: number }> | null;
};

/**
 * The gallery the form starts from: the stored images in sortOrder, or - for a
 * product without gallery rows - its existing imageUrl (a legacy /products/*.jpg
 * cover stays usable and is never forced to be re-uploaded).
 */
export function initialImages(product?: ProductImagesSource | null): string[] {
  const stored = [...(product?.images ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((image) => image.url);
  if (stored.length > 0) return stored.slice(0, MAX_PRODUCT_IMAGES);
  return product?.imageUrl ? [product.imageUrl] : [];
}

export function remainingSlots(images: readonly string[]): number {
  return Math.max(0, MAX_PRODUCT_IMAGES - images.length);
}

/** "3/8" */
export function imageCounter(images: readonly string[]): string {
  return `${images.length}/${MAX_PRODUCT_IMAGES}`;
}

/** Append new urls in order, skipping ones already present, never past the maximum. */
export function addImages(images: readonly string[], urls: readonly string[]): string[] {
  const next = [...images];
  for (const url of urls) {
    if (next.length >= MAX_PRODUCT_IMAGES) break;
    if (url && !next.includes(url)) next.push(url);
  }
  return next;
}

/** Move one image up (-1) or down (+1). Out-of-range moves return the list unchanged. */
export function moveImage(images: readonly string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= images.length || target < 0 || target >= images.length) return [...images];
  const next = [...images];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeImage(images: readonly string[], index: number): string[] {
  return images.filter((_, i) => i !== index);
}

export function coverImage(images: readonly string[]): string | undefined {
  return images[0];
}

export function isCover(index: number): boolean {
  return index === 0;
}

/** The part of the payload the backend reads: the ordered list, and the cover as imageUrl. */
export function imagesPayload(images: readonly string[]): { images: string[]; imageUrl: string } | null {
  if (images.length === 0) return null;
  return { images: [...images], imageUrl: images[0] };
}

export type UploadOutcome = {
  /** Urls uploaded in THIS run, in order (already handed to onUploaded). */
  uploaded: string[];
  /** Files not uploaded because the gallery was full. */
  skipped: number;
  /** The first failure; uploading stops there. Earlier successes are kept. */
  error: unknown | null;
};

/**
 * Upload files ONE AT A TIME (the upload endpoint is rate-limited per IP) into the
 * free slots. Every success is reported immediately through onUploaded, so a later
 * failure never loses what was already uploaded or any other form state.
 */
export async function uploadSequentially<F>(
  files: readonly F[],
  freeSlots: number,
  upload: (file: F) => Promise<string>,
  onUploaded: (url: string) => void,
): Promise<UploadOutcome> {
  const accepted = files.slice(0, Math.max(0, freeSlots));
  const outcome: UploadOutcome = { uploaded: [], skipped: files.length - accepted.length, error: null };
  for (const file of accepted) {
    try {
      const url = await upload(file);
      outcome.uploaded.push(url);
      onUploaded(url);
    } catch (error) {
      outcome.error = error;
      break;
    }
  }
  return outcome;
}
