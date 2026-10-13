import { registerDecorator, ValidationOptions } from 'class-validator';
import { apiRouteBase } from '../../../upload/upload.service';
import { STORED_UPLOAD_NAME } from '../../../upload/upload.util';

/**
 * The PRIVATE receipt URL the receipt-upload endpoints return (L8):
 * `<API base>/payments/receipts/<ms>-<32 hex>.<jpg|png|webp>`. Public `/uploads/...`
 * paths are no longer accepted for a receipt - receipts must not be publicly readable.
 */
function isReceiptPath(pathname: string): boolean {
  const prefix = `${apiRouteBase()}/payments/receipts/`;
  return pathname.startsWith(prefix) && STORED_UPLOAD_NAME.test(pathname.slice(prefix.length));
}

/**
 * True only when `value` references an application-owned private receipt - a
 * root-relative receipt path or an absolute URL on the configured APP_URL host.
 * Arbitrary/external/`javascript:` URLs and path tricks are rejected.
 */
export function isAppUploadUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;

  let pathname: string;
  let host: string | null = null;

  if (value.startsWith('/')) {
    pathname = value.split(/[?#]/)[0];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    pathname = url.pathname;
    host = url.host;
  }

  if (!isReceiptPath(pathname)) return false;

  // When an absolute URL is given and APP_URL is configured, the host must match.
  const appUrl = process.env.APP_URL;
  if (host && appUrl) {
    try {
      if (host !== new URL(appUrl).host) return false;
    } catch {
      // APP_URL misconfigured → fall back to path-shape validation only.
    }
  }
  return true;
}

export function IsAppUploadUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAppUploadUrl',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isAppUploadUrl(value),
        defaultMessage: () => 'receiptUrl must reference a receipt uploaded through this application',
      },
    });
  };
}
