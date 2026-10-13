import { readFileSync } from 'fs';
import { join } from 'path';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { ListProductsQueryDto } from '../../src/modules/catalog/application/dto/catalog.dto';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { UpdateProductDto } from '../../src/modules/admin/application/dto/update-product.dto';

/**
 * P2 #10 (isPromoSpecial) and P2 #11 (isTrialPack) — product-level homepage flags.
 *
 * Both flags follow one pattern, so every rule is checked for each of them:
 * `?<param>=` query parsing (under the SAME ValidationPipe options main.ts registers
 * - its implicit conversion would read "false" as true), the catalog `where`
 * clause, the admin DTOs, and the dev seed's contract. The real columns, defaults
 * and filtering are exercised against PostgreSQL in
 * test/integration/product-flags.int-spec.ts.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const asQuery: ArgumentMetadata = { type: 'query', metatype: ListProductsQueryDto };
const asBody = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype });

const FLAGS = [
  { param: 'promoSpecial', column: 'isPromoSpecial' },
  { param: 'trialPack', column: 'isTrialPack' },
] as const;

describe.each(FLAGS)('GET /catalog/products ?$param= parsing', ({ param }) => {
  it('"true" -> true and "false" -> false (never the implicit Boolean("false") === true)', async () => {
    expect((await pipe.transform({ [param]: 'true' }, asQuery))[param]).toBe(true);
    expect((await pipe.transform({ [param]: 'false' }, asQuery))[param]).toBe(false);
  });

  it('absent -> no filter (the existing listing is unchanged)', async () => {
    expect((await pipe.transform({}, asQuery))[param]).toBeUndefined();
  });

  it('rejects anything that is not true/false', async () => {
    for (const bad of ['yes', '1', '', 'TRUE']) {
      await expect(pipe.transform({ [param]: bad }, asQuery)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('still works together with the existing filters', async () => {
    const dto = await pipe.transform({ [param]: 'true', category: 'baso-urat', sort: 'rating' }, asQuery);
    expect(dto).toMatchObject({ [param]: true, category: 'baso-urat', sort: 'rating' });
  });
});

it('both flag filters can be combined, and each is parsed independently', async () => {
  const dto = await pipe.transform({ promoSpecial: 'true', trialPack: 'false' }, asQuery);
  expect(dto).toMatchObject({ promoSpecial: true, trialPack: false });
});

describe('PrismaCatalogRepository.listProducts', () => {
  const build = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    return { findMany, repo: new PrismaCatalogRepository({ product: { findMany } } as never) };
  };

  it.each(FLAGS)('$param=true keeps every public visibility rule and adds only $column', async ({ param, column }) => {
    const { findMany, repo } = build();
    await repo.listProducts({ [param]: true });
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: ProductStatus.ACTIVE, deletedAt: null, [column]: true });
    const other = FLAGS.find((f) => f.column !== column)!.column;
    expect(args.where[other]).toBeUndefined(); // one flag never filters on the other
    expect(args.omit).toEqual({ sku: true }); // P2 #5 unchanged
  });

  it('without the params no flag condition is added (unfiltered listing unchanged)', async () => {
    const { findMany, repo } = build();
    await repo.listProducts({});
    const where = findMany.mock.calls[0][0].where;
    for (const { column } of FLAGS) expect(where[column]).toBeUndefined();
    expect(where).toMatchObject({ status: ProductStatus.ACTIVE, deletedAt: null });
  });

  it('both params together narrow to products with both flags', async () => {
    const { findMany, repo } = build();
    await repo.listProducts({ promoSpecial: true, trialPack: true });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ isPromoSpecial: true, isTrialPack: true });
  });
});

describe.each(FLAGS)('Admin product DTOs accept $column as a boolean only', ({ column }) => {
  const baseCreate = { slug: 's', name: 'n', description: 'd', price: 1, imageUrl: '/x.png', status: 'ACTIVE', stock: 1, categoryId: 'c' };

  it('create: true/false accepted, omitted allowed', async () => {
    expect((await pipe.transform({ ...baseCreate, [column]: true }, asBody(CreateProductDto)))[column]).toBe(true);
    expect((await pipe.transform({ ...baseCreate, [column]: false }, asBody(CreateProductDto)))[column]).toBe(false);
    expect((await pipe.transform(baseCreate, asBody(CreateProductDto)))[column]).toBeUndefined();
  });

  it('update: the flag alone is a valid patch; a non-boolean is rejected, never coerced to true', async () => {
    expect(await pipe.transform({ [column]: false }, asBody(UpdateProductDto))).toMatchObject({ [column]: false });
    // Implicit conversion would read both of these as `true`.
    for (const bad of ['maybe', 'false']) {
      await expect(pipe.transform({ [column]: bad }, asBody(UpdateProductDto))).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ ...baseCreate, [column]: bad }, asBody(CreateProductDto))).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('dev seed: deterministic initial flag products', () => {
  // Read, never imported: seed.ts runs main() against a database when loaded.
  const seed = readFileSync(join(__dirname, '../../prisma/seed.ts'), 'utf8');
  const slugsOf = (constName: string) =>
    JSON.parse(
      (seed.match(new RegExp(`const ${constName} = (\\[[^\\]]*\\]) as const`))?.[1] ?? '[]').replace(/'/g, '"'),
    ) as string[];
  const seededSlugs = [...seed.matchAll(/^\s*\['([a-z0-9-]+)', '/gm)].map((m) => m[1]);

  it.each([
    { constName: 'PROMO_SPECIAL_SLUGS', column: 'isPromoSpecial', count: 3 },
    { constName: 'TRIAL_PACK_SLUGS', column: 'isTrialPack', count: 4 },
  ])('$constName: exactly $count distinct seeded products, set idempotently and only on $column', ({ constName, column, count }) => {
    const slugs = slugsOf(constName);
    expect(slugs).toHaveLength(count);
    expect(new Set(slugs).size).toBe(count);
    for (const s of slugs) expect(seededSlugs).toContain(s);

    // Created with the flag for new databases...
    expect(seed).toMatch(new RegExp(`${column}: \\(${constName} as readonly string\\[\\]\\)\\.includes\\(slug\\)`));
    // ...and an updateMany that sets ONLY this flag on ONLY these products.
    const update = [...seed.matchAll(/prisma\.product\.updateMany\(\{([\s\S]*?)\}\);/g)]
      .map((m) => m[1])
      .find((u) => u.includes(`...${constName}`));
    expect(update).toBeDefined();
    expect(update!.match(/data: \{([^}]*)\}/)?.[1].trim()).toBe(`${column}: true`);
  });

  it('products are still upserted by slug (no duplicates on re-run) and never overwritten', () => {
    expect(seed).toMatch(/prisma\.product\.upsert\(\{\s*where: \{ slug \},\s*update: \{\},/);
  });
});
