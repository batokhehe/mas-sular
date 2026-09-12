/**
 * PAYMENT_SERVICE_FEE_ENABLED — per-attempt fee against REAL PostgreSQL.
 *
 * Proves, on real rows and the migration's CHECK constraints:
 *   E. every gateway attempt snapshots its fee (calculated / customer / absorbed /
 *      toggle / rule) and the payable amount follows it;
 *   F. switching channel recalculates the fee for the NEW channel (the checkout-time
 *      figure is never reused), while replaying a live attempt keeps its snapshot;
 *   G. webhook/reconciliation amount validation (which checks the ledger row's
 *      grossAmount) accepts the charged amount and rejects the superseded one;
 *   B/D. with the fee disabled the customer pays Rp0 and the merchant cost is kept;
 *   I. manual transfer (the Midtrans-disabled path) is untouched.
 * The only double is the Midtrans provider: it records every amount it is charged.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client'
import { ChargeRequest, ChargeResult } from '../../src/modules/payments/gateway/domain/payment-provider.interface'
import { verifyMidtransStatusResponse } from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util'
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry'
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service'
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service'
import { PaymentAttemptPricingService } from '../../src/modules/payments/gateway/payment-attempt-pricing.service'
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

const BASE = 40_000 // seedScenario: subtotal 30,000 + shipping 10,000, no discount
const GATEWAY_CHANNELS = ['QRIS', 'GOPAY', 'SHOPEEPAY', 'BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA', 'CREDIT_CARD']

let world: IntegrationWorld
let ledger: PaymentGatewayPersistenceService
const charged: Array<{ channel: string; amount: number }> = []

function chargeResult(request: ChargeRequest, provider: string): ChargeResult {
  return {
    provider,
    channel: request.channel,
    providerReference: `ref-${randomUUID().slice(0, 8)}`,
    providerTransactionId: randomUUID(),
    providerOrderId: `${request.orderNumber}-${(request.attemptId ?? '').replace(/-/g, '').slice(0, 8)}`,
    providerStatus: GatewayTransactionStatus.PENDING,
    status: PaymentStatus.PENDING,
    instructions: { kind: 'VA', amount: request.amount, vaNumber: '8808123', howTo: [] },
    expiresAt: new Date(Date.now() + 60 * 60_000),
  }
}

function initiationWith(feeEnabled: boolean): PaymentInitiationService {
  const midtrans = {
    name: 'midtrans',
    supportedChannels: () => GATEWAY_CHANNELS,
    mapStatus: () => PaymentStatus.PENDING,
    createCharge: async (request: ChargeRequest) => {
      charged.push({ channel: request.channel, amount: request.amount })
      return chargeResult(request, 'midtrans')
    },
    getStatus: async () => { throw new Error('not used') },
    cancel: async () => { throw new Error('not used') },
  }
  const manual = {
    name: 'manual',
    supportedChannels: () => ['MANUAL_TRANSFER'],
    mapStatus: () => PaymentStatus.PENDING,
    createCharge: async (request: ChargeRequest) => ({ ...chargeResult(request, 'manual'), providerOrderId: undefined }),
    getStatus: async () => { throw new Error('not used') },
    cancel: async () => { throw new Error('not used') },
  }
  const providers = new PaymentProviderFactory([manual as never, midtrans as never])
  return new PaymentInitiationService(
    world.prisma, new PaymentChannelRegistry(providers), providers, ledger, undefined, { enabled: feeEnabled },
    new PaymentAttemptPricingService(world.prisma),
  )
}

/** A PENDING gateway order exactly as checkout leaves it before the first attempt. */
async function gatewayOrder() {
  const scenario = await seedScenario(world, { paymentStatus: 'PENDING' })
  await world.prisma.order.update({ where: { id: scenario.order.id }, data: { paymentMethod: PaymentMethod.GATEWAY } })
  await world.prisma.payment.update({ where: { id: scenario.payment.id }, data: { method: PaymentMethod.GATEWAY } })
  return scenario
}

const snapshot = async (orderId: string, paymentId: string) => ({
  order: await world.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
  payment: await world.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
  attempts: await world.prisma.paymentGatewayTransaction.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } }),
})

beforeAll(async () => {
  world = await getWorld()
  ledger = new PaymentGatewayPersistenceService(world.prisma)
})
beforeEach(() => { charged.length = 0 })

describe('A/E. fee ENABLED: the attempt snapshots the fee and the customer pays it', () => {
  it('BNI VA: charged base + Rp4,000; attempt, payment and order agree; nothing absorbed', async () => {
    const s = await gatewayOrder()
    const result = await initiationWith(true).initiate(s.payment.id, 'BNI_VA')

    const { order, payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      channelCode: 'BNI_VA', grossAmount: 44_000, baseAmount: BASE,
      serviceFeeCalculated: 4_000, serviceFeeCustomer: 4_000, serviceFeeAbsorbed: 0, serviceFeeEnabled: true,
    })
    expect(attempts[0].serviceFeeRule).toMatchObject({ channel: 'BNI_VA', type: 'FIXED', fixedAmount: 4_000, passThrough: 'ALLOWED' })
    expect(payment.amount).toBe(44_000)
    expect(order).toMatchObject({
      totalPrice: 44_000, paymentServiceFee: 4_000, paymentServiceFeeCalculated: 4_000,
      paymentServiceFeeAbsorbed: 0, paymentServiceFeeEnabled: true, paymentServiceFeeChannel: 'BNI_VA',
      subtotal: 30_000, deliveryFee: 10_000, voucherDiscountAmount: 0, // H: untouched by the fee
    })
    // The gateway is charged exactly the recorded attempt amount.
    expect(charged).toEqual([{ channel: 'BNI_VA', amount: 44_000 }])
    expect(result.amountBreakdown).toEqual({ baseAmount: BASE, serviceFee: 4_000, total: 44_000 })
  })
})

describe('B/D. fee DISABLED: customer pays Rp0, the merchant cost is retained', () => {
  it('BNI VA: charged the base only; Rp4,000 recorded as calculated AND absorbed', async () => {
    const s = await gatewayOrder()
    const result = await initiationWith(false).initiate(s.payment.id, 'BNI_VA')

    const { order, payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(attempts[0]).toMatchObject({
      grossAmount: BASE, baseAmount: BASE, serviceFeeCalculated: 4_000, serviceFeeCustomer: 0, serviceFeeAbsorbed: 4_000, serviceFeeEnabled: false,
    })
    expect(payment.amount).toBe(BASE)
    expect(order).toMatchObject({ totalPrice: BASE, paymentServiceFee: 0, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 4_000, paymentServiceFeeEnabled: false })
    expect(charged).toEqual([{ channel: 'BNI_VA', amount: BASE }])
    expect(result.amountBreakdown).toEqual({ baseAmount: BASE, serviceFee: 0, total: BASE })
  })
})

describe('F. switching channel recalculates for the NEW channel', () => {
  it('BNI VA -> QRIS -> GoPay: each attempt carries its own fee; the base never drifts', async () => {
    const s = await gatewayOrder()
    const init = initiationWith(true)

    await init.initiate(s.payment.id, 'BNI_VA') // +4,000
    await init.initiate(s.payment.id, 'QRIS') // QRIS may not pass the fee on: +0, merchant absorbs 280
    await init.initiate(s.payment.id, 'GOPAY') // +2% = 800

    const { order, payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(attempts.map((a) => [a.channelCode, a.status, a.grossAmount, a.serviceFeeCustomer, a.serviceFeeAbsorbed])).toEqual([
      ['BNI_VA', GatewayTransactionStatus.CANCELLED, 44_000, 4_000, 0],
      ['QRIS', GatewayTransactionStatus.CANCELLED, 40_000, 0, 280],
      ['GOPAY', GatewayTransactionStatus.PENDING, 40_800, 800, 0],
    ])
    expect(attempts.every((a) => a.baseAmount === BASE)).toBe(true)
    expect(payment.amount).toBe(40_800)
    expect(order).toMatchObject({ totalPrice: 40_800, paymentServiceFee: 800, paymentServiceFeeChannel: 'GOPAY' })
    expect(charged.map((c) => c.amount)).toEqual([44_000, 40_000, 40_800])
  })

  it('replaying the SAME live channel reuses its attempt and snapshot, even if the toggle changed since', async () => {
    const s = await gatewayOrder()
    await initiationWith(true).initiate(s.payment.id, 'BNI_VA')
    const replay = await initiationWith(false).initiate(s.payment.id, 'BNI_VA')

    const { payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ grossAmount: 44_000, serviceFeeCustomer: 4_000, serviceFeeEnabled: true })
    expect(payment.amount).toBe(44_000)
    expect(charged.map((c) => c.amount)).toEqual([44_000, 44_000]) // the live charge's amount never changes
    expect(replay.amountBreakdown).toEqual({ baseAmount: BASE, serviceFee: 4_000, total: 44_000 })
  })
})

describe('G. webhook / reconciliation amount validation follows the attempt', () => {
  it('the current attempt\'s amount verifies; the superseded attempt\'s amount is rejected', async () => {
    const s = await gatewayOrder()
    const init = initiationWith(true)
    await init.initiate(s.payment.id, 'BNI_VA')
    await init.initiate(s.payment.id, 'GOPAY')

    const { attempts } = await snapshot(s.order.id, s.payment.id)
    const live = attempts.find((a) => a.status === GatewayTransactionStatus.PENDING)!
    // Correlate exactly as the webhook does: by the order_id WE sent the gateway.
    const correlated = await ledger.findByProviderOrderId('midtrans', live.providerOrderId!)
    expect(correlated?.id).toBe(live.id)

    const body = (gross: string) => ({
      order_id: live.providerOrderId, transaction_status: 'settlement', status_code: '200', gross_amount: gross,
      transaction_id: live.providerTransactionId,
    })
    expect(verifyMidtransStatusResponse(body('40800.00'), live.providerOrderId!, correlated!.grossAmount)).toMatchObject({ ok: true })
    expect(verifyMidtransStatusResponse(body('44000.00'), live.providerOrderId!, correlated!.grossAmount)).toEqual({ ok: false, reason: 'amount_mismatch' })
    expect(verifyMidtransStatusResponse(body('40000.00'), live.providerOrderId!, correlated!.grossAmount)).toEqual({ ok: false, reason: 'amount_mismatch' })
  })
})

describe('Integrity guards', () => {
  it('a settled payment\'s amount can never be rewritten by a new attempt', async () => {
    const s = await gatewayOrder()
    await world.prisma.payment.update({ where: { id: s.payment.id }, data: { status: PaymentStatus.PAID } })
    await expect(new PaymentAttemptPricingService(world.prisma).openPricedAttempt({
      paymentId: s.payment.id, provider: 'midtrans', channelCode: 'BNI_VA', grossAmount: 44_000,
      serviceFee: { orderId: s.order.id, baseAmount: BASE, calculatedFee: 4_000, customerFee: 4_000, merchantAbsorbedFee: 0, feeEnabled: true, channel: 'BNI_VA', rule: null },
    })).rejects.toBeInstanceOf(ConflictException)
    const { payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(payment.amount).toBe(40_000)
    expect(attempts).toHaveLength(0)
  })

  it('the database rejects a breakdown that does not add up (CHECK constraints)', async () => {
    const s = await gatewayOrder()
    await expect(world.prisma.order.update({
      where: { id: s.order.id }, data: { paymentServiceFee: 4_000, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 4_000 },
    })).rejects.toThrow(/Order_paymentServiceFee_breakdown_check/)
    await expect(world.prisma.paymentGatewayTransaction.create({
      data: { paymentId: s.payment.id, provider: 'midtrans', channelCode: 'BNI_VA', grossAmount: 44_001, baseAmount: BASE, serviceFeeCalculated: 4_000, serviceFeeCustomer: 4_000 },
    })).rejects.toThrow(/PaymentGatewayTransaction_serviceFee_breakdown_check/)
  })
})

describe('I. manual transfer (Midtrans-disabled path) is unchanged', () => {
  it('no gateway fee is calculated, the amount and order totals are untouched', async () => {
    const s = await seedScenario(world, { paymentStatus: 'PENDING' }) // BANK_TRANSFER
    const result = await initiationWith(true).initiate(s.payment.id, 'MANUAL_TRANSFER')

    const { order, payment, attempts } = await snapshot(s.order.id, s.payment.id)
    expect(attempts[0]).toMatchObject({ grossAmount: 40_000, baseAmount: null, serviceFeeCalculated: 0, serviceFeeCustomer: 0, serviceFeeEnabled: null })
    expect(payment.amount).toBe(40_000)
    expect(order).toMatchObject({ totalPrice: 40_000, paymentServiceFee: 0, paymentServiceFeeCalculated: 0, paymentServiceFeeEnabled: null })
    expect(result.amountBreakdown).toBeUndefined()
    expect(charged).toEqual([]) // Midtrans never contacted
  })
})
