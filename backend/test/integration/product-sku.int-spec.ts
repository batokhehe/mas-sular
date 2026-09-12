/**
 * P2 #5 — SKU hidden from customers and admins, against REAL PostgreSQL.
 *
 * Proves what a mock cannot: the real `Product.sku String? @unique` constraint,
 * the real P2002 shape the SKU-collision retry relies on, that several NULL SKUs
 * coexist, and that the public catalog query really drops the column.
 */
import { randomUUID } from 'crypto'
import { AdminService } from '../../src/modules/admin/admin.service'
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto'
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository'
import { getWorld, IntegrationWorld } from './world'

describe('P2 #5 product SKU (real DB)', () => {
  let world: IntegrationWorld
  let admin: AdminService
  let catalog: PrismaCatalogRepository
  let categoryId: string

  beforeAll(async () => {
    world = await getWorld()
    admin = new AdminService(world.prisma as never, {} as never)
    catalog = new PrismaCatalogRepository(world.prisma as never)
    const uid = randomUUID().slice(0, 8)
    categoryId = (await world.prisma.category.create({ data: { name: `sku-${uid}`, slug: `sku-${uid}` } })).id
  })

  const dto = (slug: string, extra: Partial<CreateProductDto> = {}) =>
    ({ slug, name: `Product ${slug}`, description: 'x', price: 30000, imageUrl: '/x.png', categoryId, status: 'ACTIVE', stock: 5, ...extra }) as CreateProductDto
  const slug = (base: string) => `${base}-${randomUUID().slice(0, 6)}`

  it('creates a product with NO SKU sent: SKU is assigned from the slug', async () => {
    const s = slug('baso-urat-jumbo')
    const product = await admin.createProduct(dto(s))
    expect(product.sku).toBe(s.toUpperCase().replace(/-/g, '_'))
    expect((await world.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).sku).toBe(product.sku)
  })

  it('honours an explicit SKU from an API client', async () => {
    const product = await admin.createProduct(dto(slug('explicit'), { sku: `HAND-${randomUUID().slice(0, 6)}` }))
    expect(product.sku).toMatch(/^HAND-/)
  })

  it('moves to _2 when the derived SKU collides with a hand-set SKU (real P2002 shape)', async () => {
    const s = slug('collide')
    const derived = s.toUpperCase().replace(/-/g, '_')
    // Another product was given, by hand, exactly the SKU this slug would derive.
    await admin.createProduct(dto(slug('other'), { sku: derived }))

    const product = await admin.createProduct(dto(s))

    expect(product.sku).toBe(`${derived}_2`)
  })

  it('the unique SKU constraint is still enforced for explicit SKUs', async () => {
    const sku = `DUP-${randomUUID().slice(0, 6)}`
    await admin.createProduct(dto(slug('dup-a'), { sku }))
    await expect(admin.createProduct(dto(slug('dup-b'), { sku }))).rejects.toMatchObject({ code: 'P2002' })
  })

  it('a duplicate SLUG is still rejected, not "fixed" by the SKU retry', async () => {
    const s = slug('same-slug')
    await admin.createProduct(dto(s))
    await expect(admin.createProduct(dto(s))).rejects.toMatchObject({ code: 'P2002' })
  })

  it('several legacy products with sku = NULL coexist under @unique, and can be edited', async () => {
    const a = await world.prisma.product.create({ data: { ...dto(slug('null-a')), sku: null } })
    const b = await world.prisma.product.create({ data: { ...dto(slug('null-b')), sku: null } })
    expect([a.sku, b.sku]).toEqual([null, null])

    const edited = await admin.updateProduct(a.id, { name: 'Renamed null-SKU product' })
    expect(edited.name).toBe('Renamed null-SKU product')
    expect(edited.sku).toBeNull() // an edit never invents or clears a SKU
  })

  it('an edit without a SKU keeps the existing SKU', async () => {
    const product = await admin.createProduct(dto(slug('keep')))
    const edited = await admin.updateProduct(product.id, { price: 35000 })
    expect(edited.price).toBe(35000)
    expect(edited.sku).toBe(product.sku)
  })

  it('the public catalog sends NO sku key, for products with and without one', async () => {
    const withSku = await admin.createProduct(dto(slug('cat-with')))
    const withoutSku = await world.prisma.product.create({ data: { ...dto(slug('cat-without')), sku: null } })

    for (const p of [withSku, withoutSku]) {
      const detail = (await catalog.getProduct(p.slug)) as Record<string, unknown>
      expect(detail.id).toBe(p.id)
      expect(detail.name).toBe(p.name)              // normal product data still there
      expect(detail.category).toBeTruthy()
      expect('sku' in detail).toBe(false)           // ...but not the SKU
    }
    const list = (await catalog.listProducts({ category: undefined } as never)) as Array<Record<string, unknown>>
    const ours = list.filter((p) => p.id === withSku.id || p.id === withoutSku.id)
    expect(ours).toHaveLength(2)
    for (const p of ours) expect('sku' in p).toBe(false)
  })
})
