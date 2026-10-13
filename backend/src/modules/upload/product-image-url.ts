import { STORED_UPLOAD_NAME } from './upload.util';

/** Most images a product may have (sortOrder 0..7). */
export const MAX_PRODUCT_IMAGES = 8;

const PUBLIC_UPLOAD_PREFIX = '/uploads/';

function isStoredUploadPath(pathname: string): boolean {
  return pathname.startsWith(PUBLIC_UPLOAD_PREFIX) && STORED_UPLOAD_NAME.test(pathname.slice(PUBLIC_UPLOAD_PREFIX.length));
}

/**
 * True only for a PUBLIC image produced by this application's upload endpoint
 * (POST /upload), in the two shapes it can be referenced by:
 *   /uploads/<stored-name>
 *   http(s)://<APP_URL host>/uploads/<stored-name>   (what the endpoint returns)
 * where <stored-name> is `<ms>-<32 hex>.<jpg|png|webp>` (STORED_UPLOAD_NAME).
 *
 * Everything else is rejected: other hosts, other protocols (data:, javascript:,
 * file:), filesystem or other root paths, any /uploads path that is not a stored
 * name, and query strings or fragments. The exact file-name pattern also rules out
 * `..` and percent-encoded path tricks. Same structure as the private receipt check
 * in payments/application/validators/is-app-upload-url.validator.ts.
 *
 * Applies to NEW ProductImage values only. Legacy values already stored on a
 * product (e.g. /products/*.jpg) are accepted by the service when unchanged, and
 * Product.imageUrl keeps its existing validation.
 */
export function isProductImageUploadUrl(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  if (/[?#\\\s]/.test(value)) return false;

  if (value.startsWith('/')) {
    if (value.startsWith('//')) return false; // protocol-relative: another host
    return isStoredUploadPath(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!isStoredUploadPath(url.pathname)) return false;

  // An absolute URL must be on the APP_URL host - the host the upload endpoint uses.
  // Without a usable APP_URL no absolute URL can be proven app-owned.
  try {
    return Boolean(env.APP_URL) && url.host === new URL(env.APP_URL as string).host;
  } catch {
    return false;
  }
}
