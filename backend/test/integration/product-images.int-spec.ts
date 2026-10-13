/**
 * P2 product image gallery against REAL PostgreSQL: the migration's table, unique
 * index, cascade and backfill, and the admin/catalog flows through the real
 * constraints and transactions.
 */
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AdminService } from '../../src/modules/admin/admin.service'
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto'
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository'
import { getWorld, IntegrationWorld } from './world'

const MIGRATION = readFileSync(join(__dirname, '../../prisma/migrations/20260918090000_add_product_images/migration.sql'), 'utf8')
const APP_URL = 'https://api.test.invalid'
const upload = (n: number) => `${APP_URL}/uploads/17896000000${String(n).padStart(2, '0')}-${'b'.repeat(31)}${n % 10}.jpg`

type Gallery = Array<{ url: string; sortOrder: number }>

describe('P2 product images (real DB)', () => {
  let world: IntegrationWorld
  let admin: AdminService
  let catalog: PrismaCatalogRepository
  let categoryId: string
  let savedAppUrl: string | undefined

  beforeAll(async () => {
    world = await getWorld()
    admin = new AdminService(world.prisma as never, {} as never)
    catalog = new PrismaCatalogRepository(world.prisma as never)
    const uid = randomUUID().slice(0, 8)
    categoryId = (await world.prisma.category.create({ data: { name: `img-${uid}`, slug: `img-${uid}` } })).id
    savedAppUrl = process.env.APP_URL
    process.env.APP_URL = APP_URL
  })
  afterAll(() => {
    process.env.APP_URL = savedAppUrl
  })

  const slug = (base: string) => `${base}-${randomUUID().slice(0, 6)}`
  const base = (s: string) => ({ slug: s, name: `Product ${s}`, description: 'x', price: 30000, categoryId, status: 'ACTIVE' as const, stock: 5 })
  const gallery = async (productId: string): Promise<Gallery> =>
    world.prisma.productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' }, select: { url: true, sortOrder: true } })
  const cover = async (productId: string) => (await world.prisma.product.findUniqueOrThrow({ where: { id: productId } })).imageUrl

  describe('migration', () => {
    it('creates ProductImage with unique(productId, sortOrder) and an ON DELETE CASCADE foreign key', async () => {
      const columns = await world.prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'ProductImage' ORDER BY column_name`,
      )
      expect(columns).toEqual([
        { column_name: 'createdAt', data_type: 'timestamp without time zone', is_nullable: 'NO' },
        { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'productId', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'sortOrder', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'url', data_type: 'text', is_nullable: 'NO' },
      ])
      const [index] = await world.prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'ProductImage' AND indexname = 'ProductImage_productId_sortOrder_key'`,
      )
      expect(index.indexdef).toMatch(/UNIQUE INDEX .* \("productId", "sortOrder"\)/)
      const [fk] = await world.prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'ProductImage_productId_fkey'`,
      )
      expect(fk.confdeltype).toBe('c')
    })

    it('backfills products that have no gallery: sortOrder 0, url VERBATIM (legacy included), Product rows untouched', async () => {
      // Rows as they existed before the migration: products with no ProductImage.
      const legacy = await world.prisma.product.create({ data: { ...base(slug('legacy')), imageUrl: '/products/baso-keju.jpg' } })
      const uploaded = await world.prisma.product.create({ data: { ...base(slug('uploaded')), imageUrl: upload(1) } })
      const blank = await world.prisma.product.create({ data: { ...base(slug('blank')), imageUrl: '   ' } })
      const deleted = await world.prisma.product.create({ data: { ...base(slug('deleted')), imageUrl: '/products/es-teh.jpg', deletedAt: new Date() } })
      // A product that already has a gallery must not be touched (re-runnable backfill).
      const galleried = await admin.createProduct({ ...base(slug('has-gallery')), images: [upload(2), upload(3)] } as CreateProductDto)
      const before = await world.prisma.product.findMany({ where: { id: { in: [legacy.id, uploaded.id, blank.id, deleted.id, galleried.id] } }, orderBy: { id: 'asc' } })

      const backfill = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO "ProductImage"'))
      await world.prisma.$executeRawUnsafe(backfill)

      expect(await gallery(legacy.id)).toEqual([{ url: '/products/baso-keju.jpg', sortOrder: 0 }])
      expect(await gallery(uploaded.id)).toEqual([{ url: upload(1), sortOrder: 0 }])
      expect(await gallery(deleted.id)).toEqual([{ url: '/products/es-teh.jpg', sortOrder: 0 }])
      expect(await gallery(blank.id)).toEqual([])
      expect(await gallery(galleried.id)).toEqual([{ url: upload(2), sortOrder: 0 }, { url: upload(3), sortOrder: 1 }])
      const after = await world.prisma.product.findMany({ where: { id: { in: before.map((p) => p.id) } }, orderBy: { id: 'asc' } })
      expect(after).toEqual(before)

      // Running it again changes nothing.
      expect(await world.prisma.$executeRawUnsafe(backfill)).toBe(0)
    })

    it('unique(productId, sortOrder) is enforced', async () => {
      const product = await admin.createProduct({ ...base(slug('unique')), images: [upload(4)] } as CreateProductDto)
      await expect(world.prisma.productImage.create({ data: { productId: product.id, url: upload(5), sortOrder: 0 } })).rejects.toMatchObject({ code: 'P2002' })
    })

    it('a hard delete of a product cascades to its images', async () => {
      const product = await admin.createProduct({ ...base(slug('cascade')), images: [upload(6), upload(7)] } as CreateProductDto)
      await world.prisma.product.delete({ where: { id: product.id } })
      expect(await world.prisma.productImage.count({ where: { productId: product.id } })).toBe(0)
    })
  })

  describe('admin + catalog flows', () => {
    it('create with images[]: ordered gallery, cover = images[0]', async () => {
      const product = await admin.createProduct({ ...base(slug('create-images')), images: [upload(3), upload(1), upload(2)] } as CreateProductDto)
      expect(await gallery(product.id)).toEqual([{ url: upload(3), sortOrder: 0 }, { url: upload(1), sortOrder: 1 }, { url: upload(2), sortOrder: 2 }])
      expect(await cover(product.id)).toBe(upload(3))
    })

    it('create without images[] (legacy imageUrl): one gallery image equal to imageUrl', async () => {
      const product = await admin.createProduct({ ...base(slug('create-legacy')), imageUrl: '/x.png' } as CreateProductDto)
      expect(await gallery(product.id)).toEqual([{ url: '/x.png', sortOrder: 0 }])
      expect(await cover(product.id)).toBe('/x.png')
    })

    it('update with images[] replaces the gallery in order and syncs the cover; unchanged legacy url stays valid', async () => {
      const product = await world.prisma.product.create({ data: { ...base(slug('update-images')), imageUrl: '/products/baso-keju.jpg', images: { create: [{ url: '/products/baso-keju.jpg', sortOrder: 0 }] } } })
      await admin.updateProduct(product.id, { images: [upload(8), '/products/baso-keju.jpg'] })
      expect(await gallery(product.id)).toEqual([{ url: upload(8), sortOrder: 0 }, { url: '/products/baso-keju.jpg', sortOrder: 1 }])
      expect(await cover(product.id)).toBe(upload(8))

      await admin.updateProduct(product.id, { images: ['/products/baso-keju.jpg'] })
      expect(await gallery(product.id)).toEqual([{ url: '/products/baso-keju.jpg', sortOrder: 0 }])
      expect(await cover(product.id)).toBe('/products/baso-keju.jpg')
    })

    it('update without images[] preserves the gallery; an imageUrl-only change syncs only the cover row', async () => {
      const product = await admin.createProduct({ ...base(slug('update-cover')), images: [upload(1), upload(2), upload(3)] } as CreateProductDto)
      await admin.updateProduct(product.id, { name: 'Renamed' })
      expect(await gallery(product.id)).toEqual([{ url: upload(1), sortOrder: 0 }, { url: upload(2), sortOrder: 1 }, { url: upload(3), sortOrder: 2 }])

      await admin.updateProduct(product.id, { imageUrl: upload(9) })
      expect(await gallery(product.id)).toEqual([{ url: upload(9), sortOrder: 0 }, { url: upload(2), sortOrder: 1 }, { url: upload(3), sortOrder: 2 }])
      expect(await cover(product.id)).toBe(upload(9))
    })

    it('a rejected update writes nothing (product and gallery unchanged)', async () => {
      const product = await admin.createProduct({ ...base(slug('reject')), images: [upload(1)] } as CreateProductDto)
      await expect(admin.updateProduct(product.id, { name: 'Changed', images: ['https://evil.example.com/x.jpg'] })).rejects.toThrow(/images\[0\]/)
      await expect(admin.updateProduct(product.id, { images: [] })).rejects.toThrow(/at least one image/)
      const stored = await world.prisma.product.findUniqueOrThrow({ where: { id: product.id } })
      expect(stored.name).toBe(product.name)
      expect(await gallery(product.id)).toEqual([{ url: upload(1), sortOrder: 0 }])
    })

    it('public detail returns the ordered gallery; the public list does not include images', async () => {
      const product = await admin.createProduct({ ...base(slug('public')), images: [upload(5), upload(4)] } as CreateProductDto)
      const detail = (await catalog.getProduct(product.slug)) as { imageUrl: string; images: Array<{ id: string; url: string; sortOrder: number }> }
      expect(detail.imageUrl).toBe(upload(5))
      expect(detail.images.map(({ url, sortOrder }) => ({ url, sortOrder }))).toEqual([{ url: upload(5), sortOrder: 0 }, { url: upload(4), sortOrder: 1 }])
      expect(Object.keys(detail.images[0]).sort()).toEqual(['id', 'sortOrder', 'url'])

      const list = (await catalog.listProducts({ search: product.name } as never)) as Array<Record<string, unknown>>
      const row = list.find((p) => p.id === product.id)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty('images')
      expect(row?.imageUrl).toBe(upload(5))
    })
  })
})
