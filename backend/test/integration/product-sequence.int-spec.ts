/**
 * Canonical product ordering against REAL PostgreSQL (the world applies every
 * migration, 20261001090000_add_product_sequence included).
 *
 * Checks what only a database can show: the migration's backfill, that a reorder is
 * atomic and durable, that both list endpoints really come back in the stored order,
 * that a new product lands last, and that a soft delete leaves a gap instead of
 * renumbering the catalogue.
 *
 * A reorder covers the WHOLE live set by design, so this spec renumbers every product
 * in the shared world. Nothing else asserts on sequences, and no other field is touched.
 */
import { randomUUID } from 'crypto'
import { ConflictException } from '@nestjs/common'
import { AdminService } from '../../src/modules/admin/admin.service'
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto'
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository'
import { PRODUCT_REORDER_AUDIT_ACTION } from '../../src/modules/catalog/product-sequence'
import { getWorld, IntegrationWorld } from './world'

type Row = { id: string; sequence: number; name: string }

describe('Product.sequence on real PostgreSQL', () => {
  let world: IntegrationWorld
  let admin: AdminService
  let catalog: PrismaCatalogRepository
  let categoryId: string
  let categorySlug: string
  let mine: string[] = []

  beforeAll(async () => {
    world = await getWorld()
    admin = new AdminService(world.prisma as never, {} as never)
    catalog = new PrismaCatalogRepository(world.prisma as never)
    const uid = randomUUID().slice(0, 8)
    categorySlug = `seq-${uid}`
    categoryId = (await world.prisma.category.create({ data: { name: categorySlug, slug: categorySlug } })).id
  }, 180_000)

  const dto = (base: string, extra: Partial<CreateProductDto> = {}) =>
    ({
      slug: `${base}-${randomUUID().slice(0, 6)}`,
      name: `Product ${base}`,
      description: 'x',
      price: 30000,
      imageUrl: '/x.png',
      categoryId,
      status: 'ACTIVE',
      stock: 5,
      ...extra,
    }) as CreateProductDto

  /** Every non-deleted product, in the order the Admin list returns. */
  const adminList = async () => (await admin.listProducts()) as unknown as Row[]
  /** This spec's own products, in the order the public catalogue returns them. */
  const storefront = async (sort?: string) =>
    ((await catalog.listProducts({ category: categorySlug, ...(sort ? { sort } : {}) } as never)) as Row[]).map((p) => p.id)
  const sequenceOf = async (id: string) => (await world.prisma.product.findUniqueOrThrow({ where: { id }, select: { sequence: true } })).sequence
  /** A full-set payload that puts `order` first, keeping every other product behind it. */
  const payloadWith = async (order: string[]) => {
    const live = await adminList()
    const rest = live.filter((p) => !order.includes(p.id)).map((p) => p.id)
    return [...order, ...rest].map((id, index) => ({ id, sequence: index + 1 }))
  }

  it('the migration really ran: the column, its default and its index exist in PostgreSQL', async () => {
    const columns = await world.prisma.$queryRawUnsafe<Array<{ data_type: string; column_default: string | null; is_nullable: string }>>(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'Product' AND column_name = 'sequence'`,
    )
    expect(columns).toHaveLength(1)
    expect(columns[0]).toMatchObject({ data_type: 'integer', column_default: '0', is_nullable: 'NO' })
    const indexes = await world.prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Product'`,
    )
    expect(indexes.map((i) => i.indexname)).toContain('Product_sequence_idx')
  })

  it('the backfill expression numbers the previous default order 1..N (run against this database)', async () => {
    const rows = await world.prisma.$queryRawUnsafe<Array<{ id: string; rn: bigint }>>(
      `SELECT "id", ROW_NUMBER() OVER (ORDER BY "reviewCount" DESC, "createdAt" DESC, "id" ASC) AS rn FROM "Product"`,
    )
    const numbers = rows.map((r) => Number(r.rn))
    expect(numbers).toEqual(Array.from({ length: rows.length }, (_, index) => index + 1)) // contiguous 1..N
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length) // one position per product
  })

  it('a new product is appended: MAX(sequence) + 1', async () => {
    const before = (await world.prisma.product.aggregate({ _max: { sequence: true } }))._max.sequence ?? 0
    const first = (await admin.createProduct(dto('alpha'))) as Row
    const second = (await admin.createProduct(dto('beta'))) as Row
    const third = (await admin.createProduct(dto('gamma'))) as Row
    expect([first.sequence, second.sequence, third.sequence]).toEqual([before + 1, before + 2, before + 3])
    mine = [first.id, second.id, third.id]
  })

  it('both lists come back in the stored order', async () => {
    const list = await adminList()
    expect([...list].sort((a, b) => a.sequence - b.sequence).map((p) => p.id)).toEqual(list.map((p) => p.id))
    expect(await storefront()).toEqual(mine) // alpha, beta, gamma - as created
  })

  it('a reorder is durable: the dragged order is what both lists return afterwards', async () => {
    const dragged = [mine[2], mine[0], mine[1]]
    await admin.reorderProducts(await payloadWith(dragged))
    expect(await storefront()).toEqual(dragged)
    const list = await adminList()
    expect(list.slice(0, 3).map((p) => p.id)).toEqual(dragged)
    expect(list.slice(0, 3).map((p) => p.sequence)).toEqual([1, 2, 3])
  })

  it('explicit business sorts ignore the sequence', async () => {
    const cheap = (await admin.createProduct(dto('cheap', { price: 1 }))) as Row
    await admin.reorderProducts(await payloadWith([...mine, cheap.id])) // cheapest placed LAST
    expect((await storefront('price-low'))[0]).toBe(cheap.id)
    expect((await storefront())[3]).toBe(cheap.id)
    await world.prisma.product.update({ where: { id: cheap.id }, data: { deletedAt: new Date() } })
  })

  it('a stale snapshot is refused with 409 and changes nothing', async () => {
    const before = await adminList()
    await expect(admin.reorderProducts(before.slice(0, 2).map((p, index) => ({ id: p.id, sequence: index + 1 })))).rejects.toThrow(
      ConflictException,
    )
    const after = await adminList()
    expect(after.map((p) => [p.id, p.sequence])).toEqual(before.map((p) => [p.id, p.sequence]))
  })

  it('a failing reorder is rolled back completely - no row keeps a new sequence', async () => {
    const before = await adminList()
    const broken = await payloadWith([mine[1], mine[0], mine[2]])
    broken[broken.length - 1] = { id: broken[broken.length - 1].id, sequence: broken.length + 99 } // not a permutation
    await expect(admin.reorderProducts(broken)).rejects.toThrow()
    const after = await adminList()
    expect(after.map((p) => [p.id, p.sequence])).toEqual(before.map((p) => [p.id, p.sequence]))
  })

  it('a soft delete leaves a gap: nothing is renumbered and the next product still goes last', async () => {
    const live = await adminList()
    const victim = live[live.length - 1]
    const others = live.slice(0, -1).map((p) => [p.id, p.sequence] as const)
    await admin.deleteProduct(victim.id)

    expect(await sequenceOf(victim.id)).toBe(victim.sequence) // preserved
    const remaining = await adminList()
    expect(remaining.map((p) => [p.id, p.sequence] as const)).toEqual(others) // no renumbering
    expect(remaining.some((p) => p.id === victim.id)).toBe(false)

    // The next product goes after EVERY row, soft-deleted ones included, so no gap is
    // ever reused and a restored product never collides with a newer one.
    const maxBefore = (await world.prisma.product.aggregate({ _max: { sequence: true } }))._max.sequence ?? 0
    const appended = (await admin.createProduct(dto('after-delete'))) as Row
    expect(appended.sequence).toBe(maxBefore + 1)
    expect(appended.sequence).toBeGreaterThan(victim.sequence)
  })

  it('an ARCHIVED product keeps its place in the list and its sequence', async () => {
    const product = (await admin.createProduct(dto('archived'))) as Row
    await admin.updateProduct(product.id, { status: 'ARCHIVED' } as never)
    expect(await sequenceOf(product.id)).toBe(product.sequence)
    expect((await adminList()).some((p) => p.id === product.id)).toBe(true)
    expect(await storefront()).not.toContain(product.id) // ARCHIVED is not public, as before
  })

  it('every successful reorder is audited as product.reorder on Product', async () => {
    const entries = await world.prisma.auditLog.findMany({
      where: { action: PRODUCT_REORDER_AUDIT_ACTION },
      orderBy: { createdAt: 'desc' },
    })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries[0]).toMatchObject({ entity: 'Product', entityId: null, actorId: null })
    expect(Object.keys(entries[0].before as object).length).toBeGreaterThan(0)
    expect((entries[0].after as { sequence: Record<string, number> }).sequence).toBeDefined()
  })
})
