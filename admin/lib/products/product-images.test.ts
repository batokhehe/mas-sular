import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addImages,
  coverImage,
  imageCounter,
  imagesPayload,
  initialImages,
  isCover,
  MAX_PRODUCT_IMAGES,
  moveImage,
  remainingSlots,
  removeImage,
  uploadSequentially,
} from './product-images.ts';

/**
 * P2 — Admin product image gallery. Pure helpers are exercised directly; the form
 * wiring is pinned in the source (no component-render harness in this package).
 * The server-side rules (url validation, [] and >8 rejected, transactional save)
 * are proven in the backend product-images specs.
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const FORM = strip(readFileSync(join(process.cwd(), 'app/products/components/product-form.tsx'), 'utf8'));
const url = (n: number) => `https://api.test/uploads/${n}.jpg`;

test('initial list: stored gallery in sortOrder; otherwise the legacy imageUrl; otherwise empty', () => {
  assert.deepEqual(
    initialImages({ imageUrl: url(1), images: [{ url: url(2), sortOrder: 1 }, { url: url(1), sortOrder: 0 }] }),
    [url(1), url(2)],
  );
  // A legacy cover without gallery rows stays usable - no forced re-upload.
  assert.deepEqual(initialImages({ imageUrl: '/products/baso-keju.jpg', images: [] }), ['/products/baso-keju.jpg']);
  assert.deepEqual(initialImages({ imageUrl: '/products/baso-keju.jpg' }), ['/products/baso-keju.jpg']);
  assert.deepEqual(initialImages(undefined), []);
});

test('reorder: up/down swap neighbours; the ends do not move', () => {
  const list = [url(1), url(2), url(3)];
  assert.deepEqual(moveImage(list, 1, -1), [url(2), url(1), url(3)]);
  assert.deepEqual(moveImage(list, 1, 1), [url(1), url(3), url(2)]);
  assert.deepEqual(moveImage(list, 0, -1), list);
  assert.deepEqual(moveImage(list, 2, 1), list);
  assert.deepEqual(list, [url(1), url(2), url(3)], 'input is never mutated');
});

test('remove drops exactly one image (the file itself is never deleted - no API call exists for it)', () => {
  assert.deepEqual(removeImage([url(1), url(2), url(3)], 1), [url(1), url(3)]);
  assert.deepEqual(removeImage([url(1)], 0), []);
});

test('cover is always the first image; moving another image up makes it the cover', () => {
  const list = [url(1), url(2)];
  assert.equal(coverImage(list), url(1));
  assert.equal(isCover(0), true);
  assert.equal(isCover(1), false);
  assert.equal(coverImage(moveImage(list, 1, -1)), url(2));
  assert.deepEqual(imagesPayload([url(2), url(1)]), { images: [url(2), url(1)], imageUrl: url(2) });
  assert.equal(imagesPayload([]), null);
});

test('maximum 8: counter, free slots, add never exceeds it and skips duplicates', () => {
  assert.equal(MAX_PRODUCT_IMAGES, 8);
  const seven = Array.from({ length: 7 }, (_, i) => url(i));
  assert.equal(imageCounter(seven), '7/8');
  assert.equal(remainingSlots(seven), 1);
  const eight = addImages(seven, [url(10), url(11)]);
  assert.equal(eight.length, 8);
  assert.equal(imageCounter(eight), '8/8');
  assert.equal(remainingSlots(eight), 0);
  assert.deepEqual(addImages([url(1)], [url(1), url(2)]), [url(1), url(2)]);
});

test('uploads run one at a time into free slots; a failure keeps earlier uploads and stops', async () => {
  let gallery = [url(1)];
  const order: string[] = [];
  const upload = async (name: string) => {
    order.push(name);
    if (name === 'bad') throw new Error('429');
    return `https://api.test/uploads/${name}.jpg`;
  };
  const outcome = await uploadSequentially(['a', 'b', 'bad', 'c'], remainingSlots(gallery), upload, (u) => {
    gallery = addImages(gallery, [u]);
  });
  assert.deepEqual(order, ['a', 'b', 'bad'], 'sequential, stops at the failure');
  assert.deepEqual(outcome.uploaded, ['https://api.test/uploads/a.jpg', 'https://api.test/uploads/b.jpg']);
  assert.ok(outcome.error instanceof Error);
  assert.deepEqual(gallery, [url(1), 'https://api.test/uploads/a.jpg', 'https://api.test/uploads/b.jpg'], 'existing + earlier uploads kept');

  const full = await uploadSequentially(['x', 'y', 'z'], 1, async (n) => n, () => undefined);
  assert.deepEqual(full, { uploaded: ['x'], skipped: 2, error: null });
});

test('form wiring: existing upload endpoint, multiple files, cover badge, up/down/remove, 8/8 counter', () => {
  assert.match(FORM, /import \{ uploadImage \} from '@\/lib\/upload';/);
  assert.equal(/fetch\(/.test(FORM), false, 'no second upload path');
  assert.match(FORM, /type="file"\s+accept="image\/\*"\s+multiple/);
  assert.match(FORM, /disabled=\{isUploading \|\| remainingSlots\(images\) === 0\}/);
  assert.match(FORM, /\{imageCounter\(images\)\}/);
  assert.match(FORM, /\{isCover\(index\) && \([\s\S]*?Cover[\s\S]*?\)\}/);
  for (const action of ['moveImage\\(current, index, -1\\)', 'moveImage\\(current, index, 1\\)', 'removeImage\\(current, index\\)']) {
    assert.match(FORM, new RegExp(`setImages\\(\\(current\\) => ${action}\\)`));
  }
  for (const label of ['Move image \\$\\{index \\+ 1\\} up', 'Move image \\$\\{index \\+ 1\\} down', 'Remove image \\$\\{index \\+ 1\\}']) {
    assert.match(FORM, new RegExp(`aria-label=\\{\`${label}\`\\}`));
  }
});

test('form wiring: legacy start, successes kept on failure, images[] sent in display order', () => {
  assert.match(FORM, /useState<string\[\]>\(\(\) => initialImages\(initialValues\)\)/);
  assert.match(FORM, /\(url\) => setImages\(\(current\) => addImages\(current, \[url\]\)\)/);
  assert.match(FORM, /Gambar yang sudah terunggah tetap disimpan/);
  assert.match(FORM, /const gallery = imagesPayload\(images\);/);
  assert.match(FORM, /Unggah gambar terlebih dahulu/);
});
