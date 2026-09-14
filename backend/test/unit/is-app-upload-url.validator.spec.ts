import { isAppUploadUrl } from '../../src/modules/payments/application/validators/is-app-upload-url.validator';

/** L8: a receipt URL must reference a PRIVATE receipt returned by the upload endpoints. */
describe('isAppUploadUrl (receipt URLs)', () => {
  const OLD = process.env.APP_URL;
  const FILE = `1789310676863-${'a'.repeat(32)}.png`;
  afterEach(() => {
    if (OLD === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = OLD;
  });

  it('accepts a root-relative private receipt path', () => {
    expect(isAppUploadUrl(`/api/v1/payments/receipts/${FILE}`)).toBe(true);
    expect(isAppUploadUrl(`/api/v1/payments/receipts/${FILE.replace('.png', '.webp')}`)).toBe(true);
  });

  it('accepts an absolute receipt URL on the configured APP_URL host', () => {
    process.env.APP_URL = 'https://api.shop.example.com';
    expect(isAppUploadUrl(`https://api.shop.example.com/api/v1/payments/receipts/${FILE}`)).toBe(true);
  });

  it('rejects a receipt URL on a different host', () => {
    process.env.APP_URL = 'https://api.shop.example.com';
    expect(isAppUploadUrl(`https://evil.example.com/api/v1/payments/receipts/${FILE}`)).toBe(false);
  });

  it('rejects PUBLIC /uploads paths - receipts may no longer be publicly readable', () => {
    expect(isAppUploadUrl('/uploads/1700-abcdef0123456789.png')).toBe(false);
    expect(isAppUploadUrl(`/uploads/${FILE}`)).toBe(false);
  });

  it('rejects arbitrary / external / dangerous URLs and malformed names', () => {
    expect(isAppUploadUrl('https://evil.com/phish')).toBe(false);
    expect(isAppUploadUrl('javascript:alert(1)')).toBe(false);
    expect(isAppUploadUrl(`//evil.com/api/v1/payments/receipts/${FILE}`)).toBe(false);
    expect(isAppUploadUrl('/api/v1/payments/receipts/../../etc/passwd')).toBe(false);
    expect(isAppUploadUrl('/api/v1/payments/receipts/photo.png')).toBe(false);
    expect(isAppUploadUrl(`/api/v1/payments/receipts/${FILE.replace('.png', '.svg')}`)).toBe(false);
    expect(isAppUploadUrl('')).toBe(false);
    expect(isAppUploadUrl(undefined)).toBe(false);
  });
});
