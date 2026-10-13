/**
 * The Audit Trail against a FRESH, migrated PostgreSQL (Testcontainers - never a
 * real environment): an Outlet row read back from the database carries Prisma
 * Decimal latitude/longitude, and recording its update must produce a real
 * AuditTrail row. The negative control proves the unsanitized row is what Prisma
 * rejected on staging, so this test would have caught it.
 */
import { AuditTrailService } from '../../src/infrastructure/audit/audit-trail.service'
import { getWorld, IntegrationWorld } from './world'

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the audit row')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('Audit Trail with Decimal columns (real DB)', () => {
  let world: IntegrationWorld

  beforeAll(async () => {
    world = await getWorld()
  })

  it('negative control: Prisma rejects the raw Decimal-bearing row as JSON (the staging failure)', async () => {
    const outlet = await world.prisma.outlet.create({ data: { name: 'Control Outlet', postalCode: '40286', latitude: -6.9532467, longitude: 107.6630995 } })
    const row = await world.prisma.outlet.findUniqueOrThrow({ where: { id: outlet.id } })
    // What the old sanitizer produced from a Decimal: its own enumerable keys, `constructor` included.
    const walked = Object.fromEntries(Object.keys(row.latitude!).map((k) => [k, (row.latitude as unknown as Record<string, unknown>)[k]]))
    await expect(
      world.prisma.auditTrail.create({ data: { module: 'outlets', entity: 'Outlet', action: 'UPDATE', success: true, before: { latitude: walked } as never } }),
    ).rejects.toThrow(/constructor|serialize/i)
  })

  it('an outlet update with Decimal coordinates writes one audit row with exact values and a useful diff', async () => {
    const audit = new AuditTrailService(world.prisma)
    const outlet = await world.prisma.outlet.create({ data: { name: 'Mas Sular - Saturnus', postalCode: '40286', latitude: -6.9532467, longitude: 107.6630995 } })
    const before = await world.prisma.outlet.findUniqueOrThrow({ where: { id: outlet.id } })
    const after = await world.prisma.outlet.update({ where: { id: outlet.id }, data: { addressDetail: 'Jl. Saturnus Sel. No.3' } })
    expect(typeof before.latitude?.toFixed).toBe('function') // really a Prisma Decimal

    audit.record({ adminId: null, adminName: 'Super Admin', module: 'outlets', entity: 'Outlet', entityId: outlet.id, action: 'UPDATE', before, after, success: true })

    const row = await waitFor(() => world.prisma.auditTrail.findFirst({ where: { entity: 'Outlet', entityId: outlet.id } }))
    expect(row).toMatchObject({ module: 'outlets', action: 'UPDATE', success: true, entityName: 'Mas Sular - Saturnus' })
    expect(row.before).toMatchObject({ latitude: -6.9532467, longitude: 107.6630995, addressDetail: null })
    expect(row.after).toMatchObject({ latitude: -6.9532467, longitude: 107.6630995, addressDetail: 'Jl. Saturnus Sel. No.3' })
    expect(row.diff).toEqual([{ field: 'addressDetail', before: null, after: 'Jl. Saturnus Sel. No.3' }])
    expect(await world.prisma.auditTrail.count({ where: { entityId: outlet.id } })).toBe(1)
  })

  it('a Product (Decimal rating) update is audited too', async () => {
    const audit = new AuditTrailService(world.prisma)
    const category = await world.prisma.category.create({ data: { name: 'Audit Cat', slug: `audit-cat-${Date.now()}` } })
    const product = await world.prisma.product.create({
      data: { name: 'Audit Baso', slug: `audit-baso-${Date.now()}`, description: 'x', price: 45000, stock: 1, imageUrl: '/x.jpg', categoryId: category.id, rating: 4.8 },
    })
    const before = await world.prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    const after = await world.prisma.product.update({ where: { id: product.id }, data: { weightGram: 250 } })

    audit.record({ module: 'products', entity: 'Product', entityId: product.id, action: 'UPDATE', before, after, success: true })

    const row = await waitFor(() => world.prisma.auditTrail.findFirst({ where: { entity: 'Product', entityId: product.id } }))
    expect(row.after).toMatchObject({ rating: 4.8, weightGram: 250 })
    expect(row.diff).toEqual([{ field: 'weightGram', before: null, after: 250 }])
  })
})
