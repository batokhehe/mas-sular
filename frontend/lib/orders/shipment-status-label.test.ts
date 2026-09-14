import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHIPMENT_LABEL, shipmentStatusLabel } from './shipment-status-label.ts'

/**
 * Staging /orders showed "This page couldn't load": order BMS-20260914-5C7V0SVD had a
 * shipment in status CREATED, which the storefront's ShipmentStatus type (6 of the
 * backend's 11 values) did not know, so `SHIPMENT_LABEL[status].variant` threw a
 * TypeError during render and took the whole page down.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const prismaEnum = (name: string) => {
  const block = read('../backend/prisma/schema.prisma').match(new RegExp(`enum ${name} \\{([^}]*)\\}`))
  assert.ok(block, `enum ${name} exists in schema.prisma`)
  return block[1].split('\n').map((l) => l.trim()).filter(Boolean)
}

test('the storefront ShipmentStatus lists exactly the backend enum values', () => {
  const backend = prismaEnum('ShipmentStatus')
  const storefront = read('lib/types/enums.ts').match(/export const ShipmentStatus = \{([^}]*)\}/)
  assert.ok(storefront)
  const values = [...storefront[1].matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1])
  assert.deepEqual([...values].sort(), [...backend].sort())
})

test('every backend shipment status has a label (the CREATED case that crashed /orders)', () => {
  for (const status of prismaEnum('ShipmentStatus')) {
    const view = shipmentStatusLabel(status)
    assert.ok(view.label && view.label !== status, `${status} has a customer label`)
    assert.ok(['default', 'secondary', 'destructive', 'outline'].includes(view.variant))
  }
  assert.deepEqual(shipmentStatusLabel('CREATED'), { label: 'Booked', variant: 'secondary' })
  assert.deepEqual(shipmentStatusLabel('CANCELLED'), { label: 'Cancelled', variant: 'destructive' })
})

test('the previously known labels are unchanged', () => {
  assert.deepEqual(SHIPMENT_LABEL.PENDING, { label: 'Pending', variant: 'outline' })
  assert.deepEqual(SHIPMENT_LABEL.RATE_SELECTED, { label: 'Rate selected', variant: 'outline' })
  assert.deepEqual(SHIPMENT_LABEL.PICKED_UP, { label: 'Picked up', variant: 'secondary' })
  assert.deepEqual(SHIPMENT_LABEL.IN_TRANSIT, { label: 'In transit', variant: 'secondary' })
  assert.deepEqual(SHIPMENT_LABEL.DELIVERED, { label: 'Delivered', variant: 'default' })
  assert.deepEqual(SHIPMENT_LABEL.FAILED, { label: 'Failed', variant: 'destructive' })
})

test('a status this build has never seen shows as-is instead of throwing', () => {
  assert.deepEqual(shipmentStatusLabel('RETURNED_TO_SENDER'), { label: 'RETURNED_TO_SENDER', variant: 'outline' })
  // Prototype keys are not labels.
  assert.deepEqual(shipmentStatusLabel('toString'), { label: 'toString', variant: 'outline' })
  assert.deepEqual(shipmentStatusLabel('constructor'), { label: 'constructor', variant: 'outline' })
})

test('/orders reads shipment badges only through the helper', () => {
  const page = read('app/orders/page.tsx')
  assert.match(page, /const shipmentBadge = order\.shipment \? shipmentStatusLabel\(order\.shipment\.status\) : undefined/)
  assert.doesNotMatch(page, /SHIPMENT_LABEL\[/)
  // Order and payment status maps cover their backend enums, so they cannot hit the same crash.
  const orderMeta = page.match(/const ORDER_META[^=]*= \{([^}]*(?:\}[^}]*)*?)\n\}/)
  assert.ok(orderMeta)
  for (const status of prismaEnum('OrderStatus')) assert.match(orderMeta[1], new RegExp(`\\b${status}: \\{`), `ORDER_META has ${status}`)
  for (const status of prismaEnum('PaymentStatus')) assert.match(page, new RegExp(`\\b${status}: \\{ label:`), `PAYMENT_LABEL has ${status}`)
})
