/**
 * P2 #14 — customer invoice links against REAL PostgreSQL (the world applies every
 * migration, including 20260911130000_add_order_invoice_token).
 *
 * Proves: the stored row holds only the hash; a token opens exactly its own order;
 * expired / rotated-out / malformed tokens and deleted orders are all the same 404.
 */
import { createHash, randomUUID } from 'crypto'
import { NotFoundException } from '@nestjs/common'
import { PaymentMethod } from '@prisma/client'
import { InvoiceTokenService } from '../../src/modules/invoices/invoice-token.service'
import { InvoiceService } from '../../src/modules/invoices/invoice.service'
import { AdminInvoiceLinkService } from '../../src/modules/admin/admin-invoice-link.service'
import { getWorld, IntegrationWorld } from './world'

describe('P2 #14 invoice links (real DB)', () => {
  let world: IntegrationWorld
  let tokens: InvoiceTokenService
  let invoices: InvoiceService
  let admin: AdminInvoiceLinkService
  const ids: { orderA: string; orderB: string; numberA: string; numberB: string } = { orderA: '', orderB: '', numberA: '', numberB: '' }

  beforeAll(async () => {
    process.env.PAYMENT_UPLOAD_BASE_URL = 'https://shop.example'
    world = await getWorld()
    tokens = new InvoiceTokenService(world.prisma as never)
    invoices = new InvoiceService(world.prisma as never, tokens)
    admin = new AdminInvoiceLinkService(world.prisma as never, tokens, { send: jest.fn() } as never)

    const uid = randomUUID().slice(0, 8)
    const category = await world.prisma.category.create({ data: { name: `inv-${uid}`, slug: `inv-${uid}` } })
    const product = await world.prisma.product.create({
      data: { slug: `inv-p-${uid}`, sku: `INV-${uid}`, name: 'Baso Invoice', description: 'x', price: 45000, imageUrl: '/x.png', categoryId: category.id, stock: 10 },
    })
    const user = await world.prisma.user.create({ data: { email: `inv-${uid}@example.test`, name: 'Invoice Tester' } })
    const address = await world.prisma.address.create({
      data: { userId: user.id, label: 'Rumah', recipientName: 'Budi', phone: '6281234567890', fullAddress: 'Jl. Invoice No. 1', latitude: -6.9, longitude: 107.6 },
    })
    const mkOrder = async (suffix: string, qty: number) =>
      world.prisma.order.create({
        data: {
          orderNumber: `BMS-INV-${uid}-${suffix}`,
          userId: user.id,
          addressId: address.id,
          subtotal: 45000 * qty,
          deliveryFee: 20000,
          totalPrice: 45000 * qty + 20000,
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          items: { create: [{ productId: product.id, productName: 'Baso Invoice', unitPrice: 45000, quantity: qty }] },
          payment: { create: { method: PaymentMethod.BANK_TRANSFER, amount: 45000 * qty + 20000 + 321, uniqueCode: 321 } },
        },
      })
    const a = await mkOrder('A', 2)
    const b = await mkOrder('B', 5)
    Object.assign(ids, { orderA: a.id, orderB: b.id, numberA: a.orderNumber, numberB: b.orderNumber })
  })

  const expect404 = async (raw: string) => {
    const err = await invoices.getByToken(raw).catch((e) => e)
    expect(err).toBeInstanceOf(NotFoundException)
  }

  it('2/3. stores only the hash; the valid link opens its own order with the right items and totals', async () => {
    const issued = await tokens.issue(ids.orderA, 'admin-1')
    const row = await world.prisma.orderInvoiceToken.findUniqueOrThrow({ where: { id: issued.id } })
    expect(row.tokenHash).toBe(createHash('sha256').update(issued.rawToken).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(issued.rawToken)
    expect(await world.prisma.orderInvoiceToken.count({ where: { tokenHash: issued.rawToken } })).toBe(0)

    const inv = await invoices.getByToken(issued.rawToken)
    expect(inv.orderNumber).toBe(ids.numberA)
    expect(inv.items).toEqual([expect.objectContaining({ name: 'Baso Invoice', quantity: 2, unitPrice: 45000, lineTotal: 90000 })])
    expect(inv).toMatchObject({ subtotal: 90000, shippingCost: 20000, total: 110000 })
    expect(inv.payment).toEqual({ method: 'BANK_TRANSFER', status: 'PENDING', amountDue: 110321, uniqueCode: 321 })
    expect(inv.delivery.phone).toBe('6281******890')
    expect(JSON.stringify(inv)).not.toMatch(new RegExp(`${ids.orderA}|invoice-tester|@example\\.test`, 'i'))
  })

  it('6/9. a link is scoped to one order: A\'s link never shows B, B\'s never shows A', async () => {
    const a = await tokens.issue(ids.orderA, null)
    const b = await tokens.issue(ids.orderB, null)
    expect(a.rawToken).not.toBe(b.rawToken)
    expect((await invoices.getByToken(a.rawToken)).orderNumber).toBe(ids.numberA)
    expect((await invoices.getByToken(b.rawToken)).orderNumber).toBe(ids.numberB)
    // There is no other input: an order id (or number) is not a token.
    await expect404(ids.orderB)
    await expect404(ids.numberB)
  })

  it('4/7. wrong and malformed tokens are rejected', async () => {
    await expect404('d'.repeat(64)) // well-formed but never issued
    await expect404('not-a-token')
    await expect404('')
  })

  it('5. an expired link is rejected', async () => {
    const issued = await tokens.issue(ids.orderA, null)
    await world.prisma.orderInvoiceToken.update({ where: { id: issued.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expect404(issued.rawToken)
  })

  it('creating a new link from the Admin revokes the previous one (one working link per order)', async () => {
    const first = await admin.create(ids.orderB, { id: 'admin-1', name: 'A' })
    const firstRaw = first.invoiceUrl.split('/invoice/')[1]
    expect((await invoices.getByToken(firstRaw)).orderNumber).toBe(ids.numberB)

    const second = await admin.create(ids.orderB, { id: 'admin-1', name: 'A' })
    const secondRaw = second.invoiceUrl.split('/invoice/')[1]
    await expect404(firstRaw)
    expect((await invoices.getByToken(secondRaw)).orderNumber).toBe(ids.numberB)
    expect(await world.prisma.orderInvoiceToken.count({ where: { orderId: ids.orderB, revokedAt: null } })).toBe(1)
    expect((await admin.status(ids.orderB)).active).not.toBeNull()
  })

  it('a deleted order\'s link stops working', async () => {
    const issued = await tokens.issue(ids.orderA, null)
    await world.prisma.order.update({ where: { id: ids.orderA }, data: { deletedAt: new Date() } })
    await expect404(issued.rawToken)
    await world.prisma.order.update({ where: { id: ids.orderA }, data: { deletedAt: null } })
  })
})
