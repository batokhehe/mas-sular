import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { memoryStorage } from 'multer';
import { extname, join } from 'path';

export const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/**
 * Application-level cap (E7). nginx allows 10 MB request bodies on the API so a
 * phone photo reaches the app; the app is stricter and rejects above 8 MB.
 */
export const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Upload storage layout (H3 / L8), inside the single `uploads` volume:
 *   uploads/public/            served statically at /uploads/<file>  (catalogue & banner images)
 *   uploads/private/receipts/  NEVER served statically; read through the authenticated
 *                              GET /payments/receipts/:file endpoint (payment receipts
 *                              carry names, bank and account details).
 */
export function uploadRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.UPLOAD_ROOT?.trim() || join(process.cwd(), 'uploads');
}
export const publicUploadDir = (): string => join(uploadRoot(), 'public');
export const receiptUploadDir = (): string => join(uploadRoot(), 'private', 'receipts');

export function isAllowedImage(mimetype: string, originalName: string): boolean {
  const ext = extname(originalName).toLowerCase();
  return (
    ALLOWED_IMAGE_MIME_TYPES.includes(mimetype.toLowerCase()) &&
    ALLOWED_IMAGE_EXTENSIONS.includes(ext)
  );
}

type MulterFile = { mimetype: string; originalname: string };
type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

export function imageFileFilter(
  _req: unknown,
  file: MulterFile,
  cb: FileFilterCallback,
): void {
  if (isAllowedImage(file.mimetype, file.originalname)) {
    cb(null, true);
    return;
  }
  cb(new BadRequestException('Only jpg, jpeg, png, and webp images are allowed'), false);
}

/** Legacy name shape `<ms>-<16 hex><ext>` (kept for callers/tests that still use it). */
export function normalizeUploadFilename(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const unique = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  return `${unique}${ext}`;
}

/**
 * Multer options for EVERY upload route (H3). Files are buffered in memory and
 * never touch the disk inside Multer: a request that fails authentication,
 * authorization, token or ownership checks (all enforced by guards, which Nest runs
 * BEFORE the Multer interceptor) or fails validation leaves nothing behind. Only a
 * fully validated file is written, by persistValidatedImage().
 */
export const MEMORY_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  fileFilter: imageFileFilter,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1, fields: 5, parts: 6, headerPairs: 50 },
};

/** Per-IP ceiling for upload routes (H3), tighter than the global 120/min. */
export const UPLOAD_THROTTLE = { limit: 10, ttl: 60_000 } as const;

export type SniffedImage = 'jpeg' | 'png' | 'webp';
const EXT_FOR: Record<SniffedImage, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };

/** Identify the image by its magic bytes - the client-supplied name and MIME type are not trusted. */
export function sniffImageType(buf: Buffer | undefined): SniffedImage | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** Stored file names: `<ms>-<32 hex>.<ext>` - 128 random bits, extension from the sniffed type. */
export const STORED_UPLOAD_NAME = /^\d{10,16}-[0-9a-f]{32}\.(jpg|png|webp)$/;

/**
 * Validate an in-memory upload and write it with a fresh random name (exclusive
 * create, never overwrites). Throws 400 for a missing, oversized or non-image file.
 */
export async function persistValidatedImage(file: Express.Multer.File | undefined, dir: string): Promise<string> {
  if (!file?.buffer?.length) throw new BadRequestException('An image file is required');
  if (file.buffer.length > MAX_UPLOAD_SIZE_BYTES) throw new BadRequestException('Image is too large');
  const type = sniffImageType(file.buffer);
  if (!type) throw new BadRequestException('The file is not a valid jpg, png or webp image');

  const name = `${Date.now()}-${randomBytes(16).toString('hex')}${EXT_FOR[type]}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), file.buffer, { flag: 'wx', mode: 0o640 });
  return name;
}

export const CONTENT_TYPE_FOR_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
