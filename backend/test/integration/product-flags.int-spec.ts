/**
 * P2 #10 (isPromoSpecial) and P2 #11 (isTrialPack) against REAL PostgreSQL
 * (migrations applied by the world, including
 * 20260911090000_add_product_is_promo_special and 20260911110000_add_product_is_trial_pack).
 *
 * For each flag: the column default, that the Admin create/update paths persist it
 * both ways, and that its public catalog listing keeps every existing visibility
 * rule (ACTIVE, not soft-deleted) and still hides SKU (#5). Plus: the two flags are
 * independent of each other.
 */
import { randomUUID } from 'crypto'
import { ProductStatus } from '@prisma/client'
import { AdminService } from '../../src/modules/admin/admin.service'
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto'
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository'
import { getWorld, IntegrationWorld } from './world'

const FLAGS = [
  { param: 'promoSpecial', column: 'isPromoSpecial' },
  { param: 'trialPack', column: 'isTrialPack' },
] as const
type Column = (typeof FLAGS)[number]['column']
type Row = Record<string, unknown>

describe('P2 #10 / #11 product flags (real DB)', () => {
  let world: IntegrationWorld
  let admin: AdminService
  let catalog: PrismaCatalogRepository
  let categoryId: string
  let categorySlug: string

  beforeAll(async () => {
    world = await getWorld()
    admin = new AdminService(world.prisma as never, {} as never)
    catalog = new PrismaCatalogRepository(world.prisma as never)
    const uid = randomUUID().slice(0, 8)
    categorySlug = `flags-${uid}`
    categoryId = (await world.prisma.category.create({ data: { name: categorySlug, slug: categorySlug } })).id
  })

  const slug = (base: string) => `${base}-${randomUUID().slice(0, 6)}`
  const dto = (s: string, extra: Partial<CreateProductDto> = {}) =>
    ({ slug: s, name: `Product ${s}`, description: 'x', price: 30000, imageUrl: '/x.png', categoryId, status: 'ACTIVE', stock: 5, ...extra }) as CreateProductDto
  const stored = (id: string) => world.prisma.product.findUniqueOrThrow({ where: { id } }) as Promise<Row>
  // Scoped to this spec's own category so other specs' products cannot interfere.
  const listing = async (filters: Record<string, boolean>) =>
    (await catalog.listProducts({ ...filters, category: categorySlug })) as Row[]
  const ids = (rows: Row[]) => rows.map((p) => p.id)

  describe.each(FLAGS)('$column', ({ param, column }) => {
    const flagged = (on: boolean) => ({ [column]: on }) as Partial<CreateProductDto>

    it('1. defaults to false - through the Admin path and for a raw insert', async () => {
      const viaAdmin = (await admin.createProduct(dto(slug('plain')))) as Row
      expect(viaAdmin[column]).toBe(false)
      const raw = (await world.prisma.product.create({
        data: { slug: slug('raw'), sku: `RAW-${randomUUID().slice(0, 6)}`, name: 'Raw', description: 'x', price: 1, imageUrl: '/x.png', categoryId },
      })) as Row
      expect(raw[column]).toBe(false)
    })

    it('2. Admin can create a product with the flag true (persisted)', async () => {
      const created = (await admin.createProduct(dto(slug('on'), flagged(true)))) as Row
      expect(created[column]).toBe(true)
      expect((await stored(created.id as string))[column]).toBe(true)
    })

    it('3. Admin can update false -> true -> false; other edits leave it alone', async () => {
      const p = await admin.createProduct(dto(slug('toggle')))
      await admin.updateProduct(p.id, flagged(true))
      expect((await stored(p.id))[column]).toBe(true)
      await admin.updateProduct(p.id, { name: 'Renamed only' })
      expect((await stored(p.id))[column]).toBe(true) // omitted = unchanged
      await admin.updateProduct(p.id, flagged(false))
      const after = await stored(p.id)
      expect(after[column]).toBe(false)
      expect(after.name).toBe('Renamed only')
    })

    it('4-6. the listing returns ONLY active, non-deleted, flagged products', async () => {
      const eligible = await admin.createProduct(dto(slug('eligible'), flagged(true)))
      const notFlagged = await admin.createProduct(dto(slug('not-flagged')))
      const draft = await admin.createProduct(dto(slug('draft'), { ...flagged(true), status: ProductStatus.DRAFT }))
      const archived = await admin.createProduct(dto(slug('archived'), { ...flagged(true), status: ProductStatus.ARCHIVED }))
      const deleted = await admin.createProduct(dto(slug('deleted'), flagged(true)))
      await admin.deleteProduct(deleted.id) // soft delete

      const rows = await listing({ [param]: true })
      expect(ids(rows)).toContain(eligible.id)
      for (const excluded of [notFlagged, draft, archived, deleted]) expect(ids(rows)).not.toContain(excluded.id)
      expect(rows.every((p) => p[column] === true)).toBe(true)
      expect(new Set(ids(rows)).size).toBe(rows.length)
    })

    it('turning the flag off removes the product from the listing; on again brings it back', async () => {
      const p = await admin.createProduct(dto(slug('flip'), flagged(true)))
      expect(ids(await listing({ [param]: true }))).toContain(p.id)
      await admin.updateProduct(p.id, flagged(false))
      expect(ids(await listing({ [param]: true }))).not.toContain(p.id)
      await admin.updateProduct(p.id, flagged(true))
      expect(ids(await listing({ [param]: true }))).toContain(p.id)
    })

    it('9. the public payload carries the flag but still never the SKU (#5)', async () => {
      const p = await admin.createProduct(dto(slug('payload'), flagged(true)))
      const listed = (await listing({ [param]: true })).find((x) => x.id === p.id)!
      expect(listed[column]).toBe(true)
      expect('sku' in listed).toBe(false)
      const detail = (await catalog.getProduct(p.slug)) as Row
      expect(detail[column]).toBe(true)
      expect('sku' in detail).toBe(false)
    })
  })

  it('7. the two flags are independent: setting one never sets, clears or filters the other', async () => {
    const promoOnly = await admin.createProduct(dto(slug('promo-only'), { isPromoSpecial: true }))
    const trialOnly = await admin.createProduct(dto(slug('trial-only'), { isTrialPack: true }))
    const both = await admin.createProduct(dto(slug('both'), { isPromoSpecial: true, isTrialPack: true }))

    const promo = ids(await listing({ promoSpecial: true }))
    const trial = ids(await listing({ trialPack: true }))
    expect(promo).toEqual(expect.arrayContaining([promoOnly.id, both.id]))
    expect(promo).not.toContain(trialOnly.id)
    expect(trial).toEqual(expect.arrayContaining([trialOnly.id, both.id]))
    expect(trial).not.toContain(promoOnly.id)
    expect(ids(await listing({ promoSpecial: true, trialPack: true }))).toContain(both.id)

    // Toggling Trial Pack leaves Promo Special exactly as it was (and vice versa).
    await admin.updateProduct(both.id, { isTrialPack: false })
    expect(await stored(both.id)).toMatchObject({ isPromoSpecial: true, isTrialPack: false })
    await admin.updateProduct(both.id, { isPromoSpecial: false, isTrialPack: true })
    expect(await stored(both.id)).toMatchObject({ isPromoSpecial: false, isTrialPack: true })
  })

  it('8. existing behaviour intact: unfiltered listing still includes unflagged products; SKU still derived', async () => {
    const s = slug('existing')
    const plain = await admin.createProduct(dto(s))
    expect(plain.sku).toBe(s.toUpperCase().replace(/-/g, '_'))
    expect(ids(await listing({}))).toContain(plain.id)
    for (const { param, column } of FLAGS) {
      const off = await listing({ [param]: false })
      expect(off.every((p) => p[column as Column] === false)).toBe(true)
      expect(ids(off)).toContain(plain.id)
    }
  })
})
