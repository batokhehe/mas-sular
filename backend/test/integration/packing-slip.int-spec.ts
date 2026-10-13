/**
 * P3 Packing Slip over REAL HTTP against REAL PostgreSQL: routing, the real
 * PermissionGuard with Order.read, response headers, the mapped document, 404s -
 * and that generating a slip changes nothing and calls no provider.
 *
 * The admin session guard is replaced by a header-driven stand-in (the session
 * itself is covered by admin-session.http.spec); PermissionGuard is the real one.
 */
import { randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { ExecutionContext, INestApplication, UnauthorizedException, VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ShipmentStatus } from '@prisma/client'
import { AdminGuard } from '../../src/common/guards/admin.guard'
import { SuperAdminGuard } from '../../src/common/guards/super-admin.guard'
import { PrismaService } from '../../src/database/prisma.service'
import { AdminInvoiceLinkService } from '../../src/modules/admin/admin-invoice-link.service'
import { AdminOrderNotesService } from '../../src/modules/admin/admin-order-notes.service'
import { AdminService } from '../../src/modules/admin/admin.service'
import { ExecutiveDashboardService } from '../../src/modules/admin/executive-dashboard.service'
import { PackingSlipService } from '../../src/modules/admin/packing-slip.service'
import { AdminOperationsController } from '../../src/modules/admin/presentation/admin-operations.controller'
import { ShipmentService } from '../../src/modules/shipment/shipment.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let app: INestApplication
let base: string

/**
 * Every collaborator that could mutate state or reach a provider is an EMPTY frozen
 * object: any call into ShipmentService (couriers) or AdminService would throw and
 * turn the request into a 500, so a 200 proves none was used.
 */
const shipmentService = Object.freeze({})
const adminService = Object.freeze({})

const ROLES: Record<string, string[]> = { staff: ['Order.read'], nopermission: ['Product.read'] }

beforeAll(async () => {
  world = await getWorld()
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminOperationsController],
    providers: [
      { provide: PrismaService, useValue: world.prisma },
      PackingSlipService,
      { provide: AdminService, useValue: adminService },
      { provide: ShipmentService, useValue: shipmentService },
      { provide: ExecutiveDashboardService, useValue: {} },
      { provide: AdminOrderNotesService, useValue: {} },
      { provide: AdminInvoiceLinkService, useValue: {} },
    ],
  })
    .overrideGuard(AdminGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest()
        const role = req.headers['x-test-admin'] as string | undefined
        if (!role) throw new UnauthorizedException()
        req.user = { sub: 'admin-1', email: 'a@test', name: 'A', isActive: true, permissions: ROLES[role] ?? [] }
        return true
      },
    })
    .overrideGuard(SuperAdminGuard)
    .useValue({ canActivate: () => false })
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix('api')
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  await app.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/admin/orders`
}, 180_000)

afterAll(async () => {
  await app?.close()
})

const get = async (orderId: string, role: string | null = 'staff') => {
  const res = await fetch(`${base}/${orderId}/packing-slip`, { headers: role ? { 'x-test-admin': role } : {} })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

/** A paid, shipped order with an outlet, a regional address, two items (one with toppings) and an AWB. */
async function shippedOrder() {
  const s = await seedScenario(world, { paymentStatus: 'PAID', orderStatus: 'PROCESSING' })
  const uid = randomUUID().slice(0, 6)
  const { prisma } = world
  const outlet = await prisma.outlet.create({ data: { name: `Outlet Buahbatu ${uid}` } })
  const province = await prisma.province.create({ data: { code: `P${uid}`, name: 'Jawa Barat' } })
  const city = await prisma.city.create({ data: { code: `C${uid}`, name: 'Kota Bandung', type: 'CITY', provinceId: province.id } })
  const district = await prisma.district.create({ data: { code: `D${uid}`, name: 'Sumur Bandung', cityId: city.id } })
  const village = await prisma.village.create({ data: { code: `V${uid}`, name: 'Kebon Pisang', postalCode: '40111', districtId: district.id } })
  await prisma.address.update({
    where: { id: s.order.addressId },
    data: { recipientName: 'Budi Santoso', addressDetail: 'Jl. Veteran No. 65', postalCode: '40112', provinceId: province.id, cityId: city.id, districtId: district.id, villageId: village.id },
  })
  await prisma.order.update({ where: { id: s.order.id }, data: { outletId: outlet.id } })
  const topping = await prisma.topping.create({ data: { name: `Bihun ${uid}`, price: 5000 } })
  const [first] = await prisma.orderItem.findMany({ where: { orderId: s.order.id } })
  await prisma.orderItemTopping.create({ data: { orderItemId: first.id, toppingId: topping.id, name: topping.name, price: 5000 } })
  await prisma.orderItem.create({ data: { orderId: s.order.id, productId: s.productId, productName: 'Es Teh Manis', unitPrice: 8000, quantity: 4 } })
  const awb = `PXL-${randomUUID().replace(/-/g, '').slice(0, 20)}`
  await prisma.shipment.create({ data: { orderId: s.order.id, provider: 'paxel', service: 'NEXTDAY', status: ShipmentStatus.CREATED, cost: 18000, trackingNumber: awb } })
  return { ...s, outlet, awb, toppingName: topping.name }
}

const snapshot = async (orderId: string) => ({
  order: await world.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
  payment: await world.prisma.payment.findUnique({ where: { orderId } }),
  shipment: await world.prisma.shipment.findUnique({ where: { orderId } }),
  items: await world.prisma.orderItem.findMany({ where: { orderId }, include: { toppings: true }, orderBy: { id: 'asc' } }),
  reservations: await world.prisma.inventoryReservation.findMany({ where: { orderId } }),
  history: await world.prisma.shipmentHistory.count(),
  outbox: await world.prisma.outboxEvent.count(),
})

describe('GET /api/v1/admin/orders/:id/packing-slip (real DB, real HTTP)', () => {
  it('returns the mapped slip as JSON with Cache-Control: no-store', async () => {
    const o = await shippedOrder()
    const { status, headers, body } = await get(o.order.id)

    expect(status).toBe(200)
    expect(headers.get('content-type')).toMatch(/^application\/json/)
    expect(headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({
      orderNumber: o.order.orderNumber,
      outlet: o.outlet.name,
      recipient: {
        name: 'Budi Santoso',
        address: 'Jl. Veteran No. 65',
        regionLines: ['Kel. Kebon Pisang', 'Kec. Sumur Bandung', 'Kota Bandung', 'Jawa Barat'],
        postalCode: '40112',
        phone: o.phone,
      },
      shipment: { trackingNumber: o.awb, awbLabel: o.awb, status: 'CREATED', statusLabel: 'Pengiriman dibuat' },
    })
    expect(body.orderDate).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} WIB$/)
    expect([...body.items].sort((a: { productName: string }, b: { productName: string }) => a.productName.localeCompare(b.productName))).toEqual([
      { no: expect.any(Number), productName: 'Bakso', quantity: 1, toppings: [o.toppingName] },
      { no: expect.any(Number), productName: 'Es Teh Manis', quantity: 4, toppings: [] },
    ])
    expect(body.items.map((i: { no: number }) => i.no)).toEqual([1, 2])
    expect(JSON.stringify(body)).not.toMatch(/price|amount|payment|"email"/i)
  })

  it('order without shipment / without AWB: explicit fallbacks, never an invented AWB', async () => {
    const plain = await seedScenario(world, { paymentStatus: 'PENDING', orderStatus: 'PENDING' })
    expect((await get(plain.order.id)).body.shipment).toEqual({ trackingNumber: null, awbLabel: 'Belum tersedia', status: null, statusLabel: 'Belum ada pengiriman' })
    expect((await get(plain.order.id)).body.outlet).toBe('—')

    const rated = await seedScenario(world)
    await world.prisma.shipment.create({ data: { orderId: rated.order.id, provider: 'jne', service: 'REG', status: ShipmentStatus.RATE_SELECTED, cost: 1 } })
    expect((await get(rated.order.id)).body.shipment).toEqual({ trackingNumber: null, awbLabel: 'Belum tersedia', status: 'RATE_SELECTED', statusLabel: 'Kurir dipilih' })
  })

  it('404 for a missing order and a soft-deleted order', async () => {
    expect((await get(randomUUID())).status).toBe(404)
    const deleted = await seedScenario(world)
    await world.prisma.order.update({ where: { id: deleted.order.id }, data: { deletedAt: new Date() } })
    expect((await get(deleted.order.id)).status).toBe(404)
  })

  it('401 without an admin session; 403 without Order.read', async () => {
    const o = await seedScenario(world)
    expect((await get(o.order.id, null)).status).toBe(401)
    const denied = await get(o.order.id, 'nopermission')
    expect(denied.status).toBe(403)
    expect(JSON.stringify(denied.body)).not.toContain(o.order.orderNumber)
  })

  it('changes nothing and reaches no provider or mutating service', async () => {
    const o = await shippedOrder()
    const before = await snapshot(o.order.id)
    const realFetch = globalThis.fetch
    const outbound: string[] = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input)
      if (!target.startsWith(base)) outbound.push(target)
      return realFetch(input, init)
    }) as typeof fetch
    try {
      for (let i = 0; i < 3; i += 1) expect((await get(o.order.id)).status).toBe(200)
    } finally {
      globalThis.fetch = realFetch
    }
    const after = await snapshot(o.order.id)

    expect(after).toEqual(before)
    expect(outbound).toEqual([])
    expect(Object.keys(shipmentService)).toEqual([])
    expect(Object.keys(adminService)).toEqual([])
  })
})
