/**
 * Admin → Shipping list scope on REAL PostgreSQL: GET /admin/shipments?scope=active
 * keeps only shipments that are not DELIVERED/CANCELLED and whose order is not final
 * (DELIVERED, COMPLETED, CANCELLED), with paging and totals computed in the database.
 * Without the scope the list is exactly what it was. Read-only: nothing is modified.
 */
import { OrderStatus, ShipmentStatus } from '@prisma/client'
import { AdminService } from '../../src/modules/admin/admin.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let service: AdminService

beforeAll(async () => {
  world = await getWorld()
  // listShipments only reads through Prisma.
  service = new AdminService(world.prisma as never, {} as never)
}, 180_000)

type Seeded = { shipmentId: string; orderNumber: string; status: ShipmentStatus; orderStatus: OrderStatus }

async function shipment(status: ShipmentStatus, orderStatus: OrderStatus = OrderStatus.SHIPPED): Promise<Seeded> {
  const scenario = await seedScenario(world, { paymentStatus: 'PAID', orderStatus: 'PROCESSING' })
  await world.prisma.order.update({ where: { id: scenario.order.id }, data: { status: orderStatus } })
  const created = await world.prisma.shipment.create({
    data: { orderId: scenario.order.id, provider: 'jne', service: 'REG', status, cost: 18000, trackingNumber: `AWB-${scenario.order.orderNumber}` },
  })
  return { shipmentId: created.id, orderNumber: scenario.order.orderNumber, status, orderStatus }
}

type Page = { items: Array<{ id: string; status: ShipmentStatus }>; total: number; totalPages: number; page: number }
const list = async (query: Record<string, unknown>) => (await service.listShipments(query as never)) as unknown as Page

describe('Admin Shipping list scope on real PostgreSQL', () => {
  const seeded: Seeded[] = []

  beforeAll(async () => {
    // Every shipment status on a shipping order, plus active shipments of final orders.
    for (const status of Object.values(ShipmentStatus)) seeded.push(await shipment(status))
    seeded.push(await shipment(ShipmentStatus.CREATED, OrderStatus.CANCELLED)) // cancelled / expired payment
    seeded.push(await shipment(ShipmentStatus.IN_TRANSIT, OrderStatus.DELIVERED))
    seeded.push(await shipment(ShipmentStatus.OUT_FOR_DELIVERY, OrderStatus.COMPLETED))
    seeded.push(await shipment(ShipmentStatus.PICKED_UP, OrderStatus.DELIVERING))
  }, 180_000)

  const ids = (rows: Seeded[]) => rows.map((r) => r.shipmentId).sort()
  const expectedActive = () =>
    seeded.filter(
      (r) =>
        !(['DELIVERED', 'CANCELLED'] as ShipmentStatus[]).includes(r.status) &&
        !(['DELIVERED', 'COMPLETED', 'CANCELLED'] as OrderStatus[]).includes(r.orderStatus),
    )

  it('scope=active lists exactly the active shipments; DELIVERED / CANCELLED and final orders are hidden', async () => {
    const res = await list({ scope: 'active', limit: 100 })
    expect(res.items.map((i) => i.id).sort()).toEqual(ids(expectedActive()))
    expect(res.total).toBe(expectedActive().length)
    const shown = new Set(res.items.map((i) => i.status))
    for (const hidden of [ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED]) expect(shown.has(hidden)).toBe(false)
    for (const visible of [ShipmentStatus.PENDING, ShipmentStatus.RATE_SELECTED, ShipmentStatus.CREATED, ShipmentStatus.WAITING_PICKUP, ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.FAILED, ShipmentStatus.UNKNOWN]) {
      expect([visible, shown.has(visible)]).toEqual([visible, true])
    }
  })

  it('status + scope: an active status narrows, a finished status is empty', async () => {
    const inTransit = await list({ scope: 'active', status: ShipmentStatus.IN_TRANSIT, limit: 100 })
    // The IN_TRANSIT shipment of the DELIVERED order stays hidden.
    expect(inTransit.items.map((i) => i.id)).toEqual(ids(seeded.filter((r) => r.status === 'IN_TRANSIT' && r.orderStatus === 'SHIPPED')))
    expect(await list({ scope: 'active', status: ShipmentStatus.DELIVERED })).toMatchObject({ items: [], total: 0, totalPages: 0 })
  })

  it('pagination is computed on the filtered rows (full pages, matching total)', async () => {
    const all = expectedActive().length
    const p1 = await list({ scope: 'active', page: 1, limit: 4 })
    const p2 = await list({ scope: 'active', page: 2, limit: 4 })
    const p3 = await list({ scope: 'active', page: 3, limit: 4 })
    expect([p1.total, p1.totalPages]).toEqual([all, Math.ceil(all / 4)])
    expect(p1.items).toHaveLength(4)
    const pagedIds = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id)
    expect(new Set(pagedIds).size).toBe(pagedIds.length) // no row on two pages
    expect(pagedIds.sort()).toEqual(ids(expectedActive()))
  })

  it('without a scope the list is unchanged: every shipment, historical ones included; nothing was modified', async () => {
    const res = await list({ limit: 100 })
    expect(res.total).toBe(seeded.length)
    const rows = await world.prisma.shipment.findMany({ where: { id: { in: seeded.map((s) => s.shipmentId) } }, include: { order: true } })
    for (const s of seeded) {
      const r = rows.find((x) => x.id === s.shipmentId)!
      expect([r.status, r.order.status]).toEqual([s.status, s.orderStatus])
    }
  })
})
