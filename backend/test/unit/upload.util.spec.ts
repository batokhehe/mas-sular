import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  MEMORY_UPLOAD_OPTIONS,
  STORED_UPLOAD_NAME,
  imageFileFilter,
  isAllowedImage,
  normalizeUploadFilename,
  persistValidatedImage,
  publicUploadDir,
  receiptUploadDir,
  sniffImageType,
  uploadRoot,
} from '../../src/modules/upload/upload.util';

describe('upload.util', () => {
  describe('constants', () => {
    it('caps uploads at 8 MB in the application (nginx allows 10 MB bodies; the app is stricter)', () => {
      expect(MAX_UPLOAD_SIZE_BYTES).toBe(8 * 1024 * 1024);
    });

    it('allows only jpg/jpeg/png/webp', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS).toEqual(['.jpg', '.jpeg', '.png', '.webp']);
      expect(ALLOWED_IMAGE_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    });
  });

  describe('isAllowedImage', () => {
    it.each([
      ['image/jpeg', 'photo.jpg'],
      ['image/jpeg', 'photo.jpeg'],
      ['image/png', 'photo.png'],
      ['image/webp', 'photo.webp'],
      ['IMAGE/PNG', 'PHOTO.PNG'],
    ])('accepts %s / %s', (mime, name) => {
      expect(isAllowedImage(mime, name)).toBe(true);
    });

    it.each([
      ['image/gif', 'photo.gif'],
      ['application/pdf', 'doc.pdf'],
      ['application/octet-stream', 'malware.exe'],
      ['image/svg+xml', 'icon.svg'],
      ['image/png', 'photo.php'],
      ['image/jpeg', 'noextension'],
    ])('rejects %s / %s', (mime, name) => {
      expect(isAllowedImage(mime, name)).toBe(false);
    });

    it('rejects a spoofed mime type that does not match the extension', () => {
      expect(isAllowedImage('image/png', 'payload.exe')).toBe(false);
    });
  });

  describe('imageFileFilter', () => {
    it('accepts an allowed image', () => {
      const cb = jest.fn();
      imageFileFilter({}, { mimetype: 'image/png', originalname: 'a.png' }, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('rejects a disallowed file with a BadRequestException', () => {
      const cb = jest.fn();
      imageFileFilter({}, { mimetype: 'application/pdf', originalname: 'a.pdf' }, cb);
      const [error, accepted] = cb.mock.calls[0];
      expect(error).toBeInstanceOf(BadRequestException);
      expect(accepted).toBe(false);
    });
  });

  describe('normalizeUploadFilename', () => {
    it('preserves a lowercased allowed extension', () => {
      expect(normalizeUploadFilename('Vacation.JPG')).toMatch(/^\d+-[0-9a-f]{16}\.jpg$/);
    });

    it('discards the original basename (no user-controlled name leakage)', () => {
      const result = normalizeUploadFilename('../../etc/passwd.png');
      expect(result).not.toContain('passwd');
      expect(result).not.toContain('/');
      expect(result).not.toContain('..');
      expect(result).toMatch(/^\d+-[0-9a-f]{16}\.png$/);
    });

    it('produces unique names across calls', () => {
      const names = new Set(
        Array.from({ length: 50 }, () => normalizeUploadFilename('x.webp')),
      );
      expect(names.size).toBe(50);
    });
  });

  describe('H3: memory-only Multer options', () => {
    it('never uses disk storage and allows exactly one file', () => {
      expect(MEMORY_UPLOAD_OPTIONS.limits).toMatchObject({ fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1 });
      // multer.memoryStorage() exposes _handleFile but has no `getDestination` (diskStorage does).
      expect((MEMORY_UPLOAD_OPTIONS.storage as unknown as Record<string, unknown>).getDestination).toBeUndefined();
    });
  });

  describe('H3: sniffImageType (magic bytes, not the client name/MIME)', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
    it('recognises png, jpeg and webp', () => {
      expect(sniffImageType(png)).toBe('png');
      expect(sniffImageType(jpeg)).toBe('jpeg');
      expect(sniffImageType(webp)).toBe('webp');
    });
    it.each([
      ['a PHP script', Buffer.from('<?php system($_GET[1]); ?>')],
      ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['a GIF', Buffer.from('GIF89a' + ' '.repeat(10))],
      ['a PDF', Buffer.from('%PDF-1.7' + ' '.repeat(10))],
      ['too short', Buffer.from([0xff, 0xd8])],
    ])('rejects %s', (_label, buf) => {
      expect(sniffImageType(buf)).toBeNull();
    });
  });

  describe('H3: persistValidatedImage writes only validated images', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-persist-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const file = (buffer: Buffer) => ({ buffer, size: buffer.length, originalname: 'x.jpg', mimetype: 'image/jpeg' }) as Express.Multer.File;

    it('writes a real image under a random name with the SNIFFED extension', async () => {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
      const name = await persistValidatedImage(file(png), dir); // client said .jpg; bytes say png
      expect(name).toMatch(STORED_UPLOAD_NAME);
      expect(name.endsWith('.png')).toBe(true);
      expect(readdirSync(dir)).toEqual([name]);
    });

    it.each([
      ['a missing file', undefined],
      ['an empty file', file(Buffer.alloc(0))],
      ['a non-image', file(Buffer.from('<?php echo 1; ?>'.padEnd(32)))],
      ['an oversized buffer', file(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_UPLOAD_SIZE_BYTES)]))],
    ])('refuses %s and writes nothing', async (_label, f) => {
      await expect(persistValidatedImage(f, dir)).rejects.toBeInstanceOf(BadRequestException);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe('L8: storage layout', () => {
    const OLD = process.env.UPLOAD_ROOT;
    afterEach(() => {
      if (OLD === undefined) delete process.env.UPLOAD_ROOT;
      else process.env.UPLOAD_ROOT = OLD;
    });
    it('receipts live OUTSIDE the publicly served directory', () => {
      process.env.UPLOAD_ROOT = '/srv/uploads';
      expect(uploadRoot()).toBe('/srv/uploads');
      expect(publicUploadDir()).toBe('/srv/uploads/public');
      expect(receiptUploadDir()).toBe('/srv/uploads/private/receipts');
      expect(receiptUploadDir().startsWith(publicUploadDir())).toBe(false);
    });
  });
});
