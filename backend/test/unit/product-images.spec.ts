import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { UpdateProductDto } from '../../src/modules/admin/application/dto/update-product.dto';
import { assertProductImageList, galleryRows, sameGallery } from '../../src/modules/admin/product-images';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';
import { isProductImageUploadUrl, MAX_PRODUCT_IMAGES } from '../../src/modules/upload/product-image-url';

/**
 * P2 product image gallery - url rule, list rules, cover synchronisation, and what
 * the catalog queries load. Prisma is a stub; the real constraints are covered by
 * test/integration/product-images.int-spec.ts.
 */

const APP_URL = 'https://staging-api.baksomassular.com';
const NAME = '1789600000000-0123456789abcdef0123456789abcdef.jpg';
const upload = (n: number, ext = 'jpg') => `${APP_URL}/uploads/17896000000${String(n).padStart(2, '0')}-${'a'.repeat(31)}${n % 10}.${ext}`;

let savedAppUrl: string | undefined;
beforeAll(() => {
  savedAppUrl = process.env.APP_URL;
  process.env.APP_URL = APP_URL;
});
afterAll(() => {
  process.env.APP_URL = savedAppUrl;
});

describe('isProductImageUploadUrl — new ProductImage urls', () => {
  it.each([
    [`${APP_URL}/uploads/${NAME}`],
    [`/uploads/${NAME}`],
    [`http://staging-api.baksomassular.com/uploads/${NAME}`],
    [`${APP_URL}/uploads/1789600000000-0123456789abcdef0123456789abcdef.png`],
    [`${APP_URL}/uploads/1789600000000-0123456789abcdef0123456789abcdef.webp`],
  ])('accepts %s', (url) => {
    expect(isProductImageUploadUrl(url)).toBe(true);
  });

  it.each([
    ['external domain', `https://evil.example.com/uploads/${NAME}`],
    ['look-alike host', `https://staging-api.baksomassular.com.evil.com/uploads/${NAME}`],
    ['protocol-relative', `//evil.example.com/uploads/${NAME}`],
    ['data:', 'data:image/png;base64,iVBORw0KGgo='],
    ['javascript:', 'javascript:alert(1)'],
    ['file:', `file:///app/uploads/public/${NAME}`],
    ['ftp:', `ftp://staging-api.baksomassular.com/uploads/${NAME}`],
    ['filesystem path', `/app/uploads/public/${NAME}`],
    ['legacy storefront asset', '/products/baso-keju.jpg'],
    ['query string', `/uploads/${NAME}?v=1`],
    ['fragment', `/uploads/${NAME}#x`],
    ['arbitrary /uploads name', '/uploads/cat.jpg'],
    ['traversal', `/uploads/../private/receipts/${NAME}`],
    ['encoded traversal', `/uploads/%2e%2e/${NAME}`],
    ['nested dir', `/uploads/sub/${NAME}`],
    ['private receipt path', `/api/v1/payments/receipts/${NAME}`],
    ['svg extension', '/uploads/1789600000000-0123456789abcdef0123456789abcdef.svg'],
    ['uppercase hex', '/uploads/1789600000000-0123456789ABCDEF0123456789abcdef.jpg'],
    ['credentials in url', `https://user:pw@staging-api.baksomassular.com/uploads/${NAME}`],
    ['surrounding spaces', ` /uploads/${NAME} `],
    ['empty', ''],
    ['not a string', 42],
  ])('rejects %s', (_label, url) => {
    expect(isProductImageUploadUrl(url)).toBe(false);
  });

  it('an absolute url cannot be proven app-owned without APP_URL', () => {
    expect(isProductImageUploadUrl(`${APP_URL}/uploads/${NAME}`, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductImageUploadUrl(`/uploads/${NAME}`, {} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('assertProductImageList', () => {
  it('keeps the order and derives sortOrder 0..N-1', () => {
    const urls = [upload(3), upload(1), upload(2)];
    expect(assertProductImageList(urls)).toEqual(urls);
    expect(galleryRows(urls)).toEqual([
      { url: urls[0], sortOrder: 0 },
      { url: urls[1], sortOrder: 1 },
      { url: urls[2], sortOrder: 2 },
    ]);
  });

  it('rejects [] (a product always has a cover), more than 8, and duplicates', () => {
    expect(() => assertProductImageList([])).toThrow(/at least one image/);
    expect(MAX_PRODUCT_IMAGES).toBe(8);
    expect(() => assertProductImageList(Array.from({ length: 8 }, (_, i) => upload(i)))).not.toThrow();
    expect(() => assertProductImageList(Array.from({ length: 9 }, (_, i) => upload(i)))).toThrow(/at most 8/);
    expect(() => assertProductImageList([upload(1), upload(1)])).toThrow(/same image twice/);
  });

  it('rejects a new non-upload url, naming its position', () => {
    expect(() => assertProductImageList([upload(1), 'https://evil.example.com/x.jpg'])).toThrow(/images\[1\] must be an image uploaded through this application/);
    expect(() => assertProductImageList(['javascript:alert(1)'])).toThrow(BadRequestException);
    expect(() => assertProductImageList(['data:image/png;base64,AAAA'])).toThrow(BadRequestException);
  });

  it('a legacy url the product ALREADY has stays valid; a new legacy-shaped url does not', () => {
    const legacy = '/products/baso-keju.jpg';
    expect(assertProductImageList([legacy, upload(1)], new Set([legacy]))).toEqual([legacy, upload(1)]);
    expect(() => assertProductImageList(['/products/es-teh.jpg'], new Set([legacy]))).toThrow(/images\[0\]/);
  });

  it('sameGallery compares url AND position', () => {
    const stored = [{ url: 'b', sortOrder: 1 }, { url: 'a', sortOrder: 0 }];
    expect(sameGallery(stored, ['a', 'b'])).toBe(true);
    expect(sameGallery(stored, ['b', 'a'])).toBe(false);
    expect(sameGallery(stored, ['a'])).toBe(false);
  });
});

describe('DTO validation (global ValidationPipe settings)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
  const base = { slug: 's', name: 'n', description: 'd', price: 1, status: 'ACTIVE', stock: 1, categoryId: 'c' };
  const create = (body: object) => pipe.transform(body, { type: 'body', metatype: CreateProductDto });
  const update = (body: object) => pipe.transform(body, { type: 'body', metatype: UpdateProductDto });

  it('create: images[] alone is enough; imageUrl alone still works; neither is refused', async () => {
    await expect(create({ ...base, images: [upload(1)] })).resolves.toMatchObject({ images: [upload(1)] });
    await expect(create({ ...base, imageUrl: '/x.png' })).resolves.toMatchObject({ imageUrl: '/x.png' });
    await expect(create(base)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('images must be an array of strings, at most 8', async () => {
    await expect(create({ ...base, images: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create({ ...base, images: [1] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(update({ images: Array.from({ length: 9 }, (_, i) => upload(i)) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(update({ images: [upload(1)] })).resolves.toMatchObject({ images: [upload(1)] });
  });
});

// ------------------------------------------------------------------- service --

type Image = { id: string; url: string; sortOrder: number };

function world(current: { imageUrl: string; images: Image[] } | null = { imageUrl: '/products/baso-keju.jpg', images: [{ id: 'i0', url: '/products/baso-keju.jpg', sortOrder: 0 }] }) {
  const tx = {
    productImage: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}), upsert: jest.fn().mockResolvedValue({}) },
    product: { update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data })) },
  };
  const prisma = {
    product: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data })),
      findUnique: jest.fn().mockResolvedValue(current ? { id: 'p1', deletedAt: null, ...current } : null),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  return { admin: new AdminService(prisma as never, {} as never), prisma, tx };
}

const DTO = { slug: 'baso', name: 'Baso', description: 'x', price: 30000, categoryId: 'c1', status: 'ACTIVE', stock: 1 } as CreateProductDto;

describe('AdminService.createProduct', () => {
  it('with images[]: cover = images[0], rows in order, images never spread into Product data', async () => {
    const { admin, prisma } = world();
    const urls = [upload(2), upload(1)];
    await admin.createProduct({ ...DTO, sku: 'SKU-1', images: urls });
    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data.imageUrl).toBe(urls[0]);
    expect(data.images).toEqual({ create: [{ url: urls[0], sortOrder: 0 }, { url: urls[1], sortOrder: 1 }] });
  });

  it('without images[]: the legacy imageUrl is kept as-is and becomes the single gallery image', async () => {
    const { admin, prisma } = world();
    await admin.createProduct({ ...DTO, sku: 'SKU-1', imageUrl: '/legacy/any.png' });
    expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({ imageUrl: '/legacy/any.png', images: { create: [{ url: '/legacy/any.png', sortOrder: 0 }] } });
  });

  it('the derived-SKU path creates the gallery too', async () => {
    const { admin, prisma } = world();
    await admin.createProduct({ ...DTO, images: [upload(1)] });
    expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({ sku: 'BASO', imageUrl: upload(1), images: { create: [{ url: upload(1), sortOrder: 0 }] } });
  });

  it('rejects [], >8, duplicates, bad urls, a mismatching imageUrl — before any write', async () => {
    const { admin, prisma } = world();
    await expect(admin.createProduct({ ...DTO, images: [] })).rejects.toThrow(/at least one image/);
    await expect(admin.createProduct({ ...DTO, images: Array.from({ length: 9 }, (_, i) => upload(i)) })).rejects.toThrow(/at most 8/);
    await expect(admin.createProduct({ ...DTO, images: [upload(1), upload(1)] })).rejects.toThrow(/same image twice/);
    await expect(admin.createProduct({ ...DTO, images: ['https://evil.example.com/x.jpg'] })).rejects.toThrow(/images\[0\]/);
    await expect(admin.createProduct({ ...DTO, images: ['/products/baso-keju.jpg'] })).rejects.toThrow(/images\[0\]/);
    await expect(admin.createProduct({ ...DTO, imageUrl: upload(9), images: [upload(1)] })).rejects.toThrow(/imageUrl must equal images\[0\]/);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });
});

describe('AdminService.updateProduct', () => {
  it('without images and without a cover change: the single previous update, gallery untouched', async () => {
    const { admin, prisma } = world();
    await admin.updateProduct('p1', { name: 'Renamed', price: 1 });
    expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { name: 'Renamed', price: 1 } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // Re-sending the SAME imageUrl is not a change either.
    await admin.updateProduct('p1', { imageUrl: '/products/baso-keju.jpg' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('imageUrl-only change: product and cover row updated in ONE transaction, other images preserved', async () => {
    const { admin, prisma, tx } = world({
      imageUrl: '/products/baso-keju.jpg',
      images: [{ id: 'i0', url: '/products/baso-keju.jpg', sortOrder: 0 }, { id: 'i1', url: upload(1), sortOrder: 1 }],
    });
    await admin.updateProduct('p1', { imageUrl: upload(5) });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productImage.upsert).toHaveBeenCalledWith({
      where: { productId_sortOrder: { productId: 'p1', sortOrder: 0 } },
      update: { url: upload(5) },
      create: { productId: 'p1', url: upload(5), sortOrder: 0 },
    });
    expect(tx.productImage.deleteMany).not.toHaveBeenCalled();
    expect(tx.product.update.mock.calls[0][0].data).toEqual({ imageUrl: upload(5) });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('images[]: replaced transactionally in the given order, cover synced to images[0]', async () => {
    const { admin, prisma, tx } = world();
    const urls = [upload(3), '/products/baso-keju.jpg', upload(4)];
    await admin.updateProduct('p1', { name: 'X', images: urls });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productImage.deleteMany).toHaveBeenCalledWith({ where: { productId: 'p1' } });
    expect(tx.productImage.createMany).toHaveBeenCalledWith({
      data: [
        { url: urls[0], sortOrder: 0, productId: 'p1' },
        { url: urls[1], sortOrder: 1, productId: 'p1' }, // legacy, already on the product
        { url: urls[2], sortOrder: 2, productId: 'p1' },
      ],
    });
    expect(tx.product.update.mock.calls[0][0].data).toEqual({ name: 'X', imageUrl: urls[0] });
  });

  it('an unchanged legacy gallery is accepted and not rewritten', async () => {
    const { admin, tx } = world();
    await admin.updateProduct('p1', { name: 'X', images: ['/products/baso-keju.jpg'] });
    expect(tx.productImage.deleteMany).not.toHaveBeenCalled();
    expect(tx.productImage.createMany).not.toHaveBeenCalled();
    expect(tx.product.update.mock.calls[0][0].data).toEqual({ name: 'X', imageUrl: '/products/baso-keju.jpg' });
  });

  it('rejects [], >8, duplicates, new bad urls and a mismatching imageUrl — nothing written', async () => {
    const { admin, prisma } = world();
    await expect(admin.updateProduct('p1', { images: [] })).rejects.toThrow(/at least one image/);
    await expect(admin.updateProduct('p1', { images: Array.from({ length: 9 }, (_, i) => upload(i)) })).rejects.toThrow(/at most 8/);
    await expect(admin.updateProduct('p1', { images: [upload(1), upload(1)] })).rejects.toThrow(/same image twice/);
    await expect(admin.updateProduct('p1', { images: ['https://evil.example.com/a.jpg'] })).rejects.toThrow(/images\[0\]/);
    await expect(admin.updateProduct('p1', { images: ['data:image/png;base64,AAAA'] })).rejects.toThrow(/images\[0\]/);
    await expect(admin.updateProduct('p1', { images: ['javascript:alert(1)'] })).rejects.toThrow(/images\[0\]/);
    await expect(admin.updateProduct('p1', { images: ['/products/es-teh.jpg'] })).rejects.toThrow(/images\[0\]/); // a NEW legacy url
    await expect(admin.updateProduct('p1', { imageUrl: upload(2), images: [upload(1)] })).rejects.toThrow(/imageUrl must equal images\[0\]/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('admin GET product includes the ordered gallery', async () => {
    const { admin, prisma } = world();
    await admin.getProduct('p1');
    expect(prisma.product.findUnique).toHaveBeenCalledWith({
      where: { id: 'p1' },
      include: { images: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, sortOrder: true } } },
    });
  });
});

describe('what the product queries load', () => {
  it('admin list and public list never load images; public detail loads them ordered', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const findFirst = jest.fn().mockResolvedValue({ id: 'p1' });
    const prisma = { product: { findMany, findFirst } };

    await new AdminService(prisma as never, {} as never).listProducts();
    expect(JSON.stringify(findMany.mock.calls[0][0])).not.toContain('images');

    const catalog = new PrismaCatalogRepository(prisma as never);
    await catalog.listProducts({} as never);
    expect(JSON.stringify(findMany.mock.calls[1][0])).not.toContain('images');

    await catalog.getProduct('baso');
    expect(findFirst.mock.calls[0][0].include).toEqual({
      category: true,
      images: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, sortOrder: true } },
    });
  });
});
