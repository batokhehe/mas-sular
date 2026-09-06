import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { NotificationChannel, OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { orderStatusSourcesFor } from '../orders/domain/order-status-transitions';
import { CreateShipmentInput, ShipmentItem } from './domain/shipment-provider.interface';
import { ShipmentProviderFactory } from './shipment-provider.factory';
import { trackingCacheKey } from './shipment-sync.service';
import { readPickupDatetime, readShipmentMetadata, withPickupDatetime } from './shipment-metadata';
import { PaxelPickupScheduler } from './paxel-pickup-scheduler';

/** Region names only; ids mean nothing to a courier. */
const ADDRESS_REGION_NAMES = {
  include: {
    province: { select: { name: true } },
    city: { select: { name: true } },
    district: { select: { name: true } },
    village: { select: { name: true } },
  },
} as const;

const NON_TERMINAL_TRACKING: ShipmentStatus[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
];

// Booking claim lease: a PENDING claim older than this is considered a crashed
// attempt and may be reclaimed (@updatedAt is bumped by the claim itself).
const BOOKING_LEASE_MS = 5 * 60 * 1000;

/** Outcome error for a lost claim — callers/worker treat this as a skip, not a failure. */
export const BOOKING_IN_PROGRESS = 'Shipment booking already in progress';

/**
 * Outcome for a courier that cannot book until an admin picks a pickup time.
 * Treated as a SKIP by the automatic paths, exactly like a lost claim: the
 * shipment is waiting on a person, not broken.
 */
export const AWAITING_PICKUP_SCHEDULE = 'Awaiting admin-selected pickup schedule';

/**
 * PAXELBOX-38: the courier is quoted through the application but booked outside
 * it, so there is no airwaybill to fetch — an operator records the one they
 * arranged. Not a failure: the shipment is left exactly as it was, for the
 * manual admin flow to complete.
 */
export const AWAITING_MANUAL_FULFILMENT = 'Awaiting manual courier booking (admin enters the airwaybill)';

export interface ShipmentOutcome {
  ok: boolean;
  status: ShipmentStatus;
  trackingNumber?: string | null;
  error?: string;
}

/**
 * Creates & tracks courier shipments AFTER payment is PAID (never during checkout).
 * Uses the ShipmentProviderFactory to pick the courier that was quoted on the order.
 */
@Injectable()
export class ShipmentService {
  private readonly logger = new Logger('ShipmentService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: ShipmentProviderFactory,
    // PAXELBOX-36: drops the cached courier answer after a cancellation.
    // Optional so the many positional test constructions keep working, and safe
    // to be absent — invalidation is best-effort, never a guard.
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
    // PAXELBOX-61AG.3.32: resolves the automatic Paxel pickup appointment.
    // Optional for the same reason as `cache` — the many positional test
    // constructions — and absent means the pre-3.32 behaviour EXACTLY: a courier
    // that requires a pickup slot and has none waits for an admin.
    @Optional() private readonly pickupScheduler?: PaxelPickupScheduler,
  ) {}

  private toNum(v: unknown): number | undefined {
    return v === null || v === undefined ? undefined : Number(v);
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  /**
   * Book the shipment for an order with the courier. Idempotent: a shipment that
   * already carries a tracking number is returned unchanged. Throws on failure
   * (callers that must not surface errors use createForOrderSafe).
   */
  async createForOrder(orderId: string): Promise<ShipmentOutcome> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shipment: true,
        // Region NAMES for couriers that address on place names (Paxel requires
        // province/city/district on both endpoints).
        address: { include: ADDRESS_REGION_NAMES.include },
        user: { select: { name: true, email: true, phone: true } },
        // The authoritative settlement instant. It is what the automatic Paxel
        // pickup schedule is computed FROM — never the clock at booking time,
        // never the request, never the DB server's `now()`.
        payment: { select: { verifiedAt: true } },
        // Widened from `{ quantity }`: the courier payload needs the whole line —
        // the physical SNAPSHOT taken at checkout plus the product's sku and
        // category. One query, not one per item.
        items: {
          select: {
            quantity: true,
            productName: true,
            unitPrice: true,
            weightGram: true,
            lengthCm: true,
            widthCm: true,
            heightCm: true,
            isFragile: true,
            product: { select: { sku: true, name: true, category: { select: { name: true } } } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const shipment = order.shipment;
    if (!shipment) throw new NotFoundException('Order has no shipment row');

    // Idempotent: already booked.
    if (shipment.trackingNumber) {
      return { ok: true, status: shipment.status, trackingNumber: shipment.trackingNumber };
    }

    const providerName = order.shippingProvider ?? shipment.provider;
    const provider = this.factory.get(providerName);
    if (!provider) {
      throw new Error(`No shipment provider registered for '${providerName}'`);
    }

    // Some couriers are quoted here but booked outside the application (JNE).
    // Checked before ANYTHING else touches the row — before the outlet lookup,
    // the address checks and the CAS claim — so a manual-fulfilment order is
    // never claimed, never attempted and never marked FAILED. It simply waits
    // for the operator to record the airwaybill they arranged.
    //
    // This is the ONLY thing standing between the generic booking flow and a
    // JNE CREATE call, and it covers every caller of createForOrder at once:
    // payment verification, admin retry and the reconciliation worker.
    if (provider.supportsAutomaticBooking === false) {
      return { ok: false, status: shipment.status, error: AWAITING_MANUAL_FULFILMENT };
    }

    // Origin = the outlet allocated at checkout (order.outletId); fall back to the
    // active outlet for legacy orders that predate multi-outlet allocation.
    const outlet = order.outletId
      ? await this.prisma.outlet.findUnique({ where: { id: order.outletId }, include: ADDRESS_REGION_NAMES.include })
      : await this.prisma.outlet.findFirst({ where: { isActive: true }, include: ADDRESS_REGION_NAMES.include });
    if (!outlet || !outlet.postalCode) {
      throw new Error('No active outlet with a postal code configured');
    }
    if (!order.address?.postalCode) {
      throw new Error('Order address is missing a postal code');
    }

    // Some couriers cannot book without a pickup slot someone committed to
    // (Paxel). Checked BEFORE the claim so a shipment that still has no slot is
    // left untouched for the admin packing flow rather than claimed, attempted
    // and marked FAILED. Providers without the requirement are unaffected.
    //
    // An EXPLICIT slot always wins (PAXELBOX-61AG.3.32 §12). It is a time a human
    // committed to — read first, never recomputed, never overwritten. Automatic
    // scheduling is strictly the fallback for a shipment that has none.
    let pickupAtIso = readPickupDatetime(shipment.metadata);
    if (provider.requiresPickupSchedule && !pickupAtIso) {
      pickupAtIso = await this.scheduleAutomaticPickup(shipment.id, order.payment?.verifiedAt ?? null, orderId);
      if (!pickupAtIso) {
        return { ok: false, status: shipment.status, error: AWAITING_PICKUP_SCHEDULE };
      }
    }

    // CAS-claim the booking BEFORE the courier call (audit F3): exactly one caller
    // (verify auto-create / admin retry / reconciliation worker) flips the row to
    // PENDING; everyone else loses the claim and never reaches the provider — no
    // duplicate courier bookings. A stale PENDING (crashed attempt) is reclaimable
    // after the lease; the failure path releases the claim by marking FAILED.
    const claim = await this.prisma.shipment.updateMany({
      where: {
        id: shipment.id,
        trackingNumber: null,
        OR: [
          { status: { in: [ShipmentStatus.RATE_SELECTED, ShipmentStatus.FAILED] } },
          { status: ShipmentStatus.PENDING, updatedAt: { lte: new Date(Date.now() - BOOKING_LEASE_MS) } },
        ],
      },
      data: { status: ShipmentStatus.PENDING },
    });
    if (claim.count !== 1) {
      // Lost the race: either a concurrent booking finished (return its tracking —
      // idempotent success) or one is in flight (skip; never call the courier).
      const current = await this.prisma.shipment.findUnique({ where: { id: shipment.id } });
      if (current?.trackingNumber) {
        return { ok: true, status: current.status, trackingNumber: current.trackingNumber };
      }
      return { ok: false, status: current?.status ?? shipment.status, error: BOOKING_IN_PROGRESS };
    }

    const totalItems = order.items.reduce((sum, i) => sum + i.quantity, 0);
    const items: ShipmentItem[] = order.items.map((item) => ({
      code: item.product?.sku ?? '',
      // The order-time name, not the catalogue's current one.
      name: item.productName,
      category: item.product?.category?.name ?? '',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      // Snapshot values only. Null stays null so a provider that needs a real
      // measurement refuses the booking instead of shipping a guess.
      weightGram: item.weightGram,
      lengthCm: item.lengthCm,
      widthCm: item.widthCm,
      heightCm: item.heightCm,
      isFragile: item.isFragile,
    }));

    const input: CreateShipmentInput = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      service: order.shippingService ?? shipment.service,
      serviceName: order.shippingServiceName ?? undefined,
      // Legacy parcel-weight placeholder. Still passed for providers that price on
      // a single total (JNE); Paxel ignores it and uses the per-item snapshots.
      weightGram: Math.max(1, totalItems) * 500,
      invoiceValue: order.totalPrice,
      paymentMethod: order.paymentMethod,
      pickupAtIso,
      items,
      origin: {
        name: outlet.name,
        postalCode: outlet.postalCode,
        latitude: this.toNum(outlet.latitude),
        longitude: this.toNum(outlet.longitude),
        addressDetail: outlet.addressDetail ?? undefined,
        province: outlet.province?.name,
        city: outlet.city?.name,
        district: outlet.district?.name,
        village: outlet.village?.name,
      },
      destination: {
        name: order.address.recipientName,
        phone: order.address.phone,
        addressDetail: order.address.addressDetail ?? order.address.fullAddress,
        postalCode: order.address.postalCode,
        latitude: this.toNum(order.address.latitude),
        longitude: this.toNum(order.address.longitude),
        note: order.address.notes ?? undefined,
        province: order.address.province?.name,
        city: order.address.city?.name,
        district: order.address.district?.name,
        village: order.address.village?.name,
      },
    };

    const result = await provider.createShipment(input);

    await this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: result.status,
          trackingNumber: result.trackingNumber,
          providerShipmentId: result.providerShipmentId,
          providerPayload: this.json(result.rawPayload),
        },
      });
      // Legal-transition CAS (audit F4): only an order still in a shippable state
      // flips to SHIPPED. An order cancelled while the courier call was in flight
      // keeps CANCELLED (tracking stays recorded on the shipment for ops) and the
      // customer is NOT told it shipped.
      const flip = await tx.order.updateMany({
        where: { id: order.id, status: { in: orderStatusSourcesFor(OrderStatus.SHIPPED) } },
        data: { status: OrderStatus.SHIPPED, trackingNumber: result.trackingNumber },
      });
      if (flip.count === 1) {
        await tx.orderEvent.create({
          data: { orderId: order.id, status: OrderStatus.SHIPPED, note: `Shipment created (${providerName})` },
        });
        await this.enqueueWhatsApp(tx, 'order.shipped', order, {
          provider: providerName,
          service: order.shippingServiceName ?? order.shippingService ?? shipment.service,
          tracking: result.trackingNumber,
        });
      } else {
        this.logger.warn({ event: 'shipment.order_not_shippable', orderId: order.id, tracking: result.trackingNumber });
      }
    });

    this.logger.log({ event: 'shipment.created', orderId, provider: providerName, tracking: result.trackingNumber });
    return { ok: true, status: result.status, trackingNumber: result.trackingNumber };
  }

  /**
   * The automatic pickup appointment for a courier that requires one, or null
   * when there is none to be had — in which case the caller falls back to
   * AWAITING_PICKUP_SCHEDULE, exactly as before this existed.
   *
   * Null (not an invented time) in all three of these cases:
   *  - no scheduler wired at all — every existing positional test construction;
   *  - PAXEL_AUTO_PICKUP_ENABLED is off — the pre-3.32 behaviour, unchanged;
   *  - the payment carries no `verifiedAt`. The rule is defined in terms of the
   *    payment verification instant, and there is no second-best source for it:
   *    the clock at booking time is a different quantity, and using it would make
   *    an admin retry days later resolve to a different appointment than the
   *    settlement did. Booking only ever runs after settlement, so in the real
   *    flow this is always present.
   *
   * The resolved slot is PERSISTED before the booking is attempted, for the same
   * reason `prepareForOrder` persists the admin's: a crash between the two must
   * leave the schedule intact, so the retry books the SAME appointment rather
   * than computing a new one against a later clock.
   */
  private async scheduleAutomaticPickup(
    shipmentId: string,
    verifiedAt: Date | null,
    orderId: string,
  ): Promise<string | undefined> {
    if (!this.pickupScheduler?.enabled) return undefined;
    if (!verifiedAt) {
      this.logger.warn({ event: 'shipment.pickup_reference_missing', orderId });
      return undefined;
    }

    const pickupAtIso = this.pickupScheduler.resolveIso(verifiedAt);
    // Merge, never replace — metadata also carries failure diagnostics from an
    // earlier attempt, which are the only record of why a shipment is stuck.
    const current = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { metadata: true },
    });
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { metadata: withPickupDatetime(current?.metadata, pickupAtIso) },
    });
    this.logger.log({ event: 'shipment.pickup_scheduled', orderId, pickupAtIso, source: 'automatic' });
    return pickupAtIso;
  }

  /** Never-throwing variant used by the payment-verify flow and the retry endpoint.
   *  On failure the shipment is marked FAILED (Retry becomes available). */
  async createForOrderSafe(orderId: string): Promise<ShipmentOutcome> {
    try {
      return await this.createForOrder(orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'shipment.create_failed', orderId, error: message });
      // Merge, never replace: metadata also carries the admin-selected pickup
      // time, and overwriting it here would strand the shipment - the schedule
      // would be gone and every retry would refuse for want of a pickup slot.
      const existing = await this.prisma.shipment
        .findUnique({ where: { orderId }, select: { metadata: true } })
        .catch(() => null);
      await this.prisma.shipment
        .updateMany({
          where: { orderId, trackingNumber: null },
          data: {
            status: ShipmentStatus.FAILED,
            metadata: this.json({
              ...readShipmentMetadata(existing?.metadata),
              error: message,
              failedAt: new Date().toISOString(),
            }),
          },
        })
        .catch(() => undefined);
      return { ok: false, status: ShipmentStatus.FAILED, error: message };
    }
  }

  /**
   * Admin packing action: record the pickup slot the operator committed to, then
   * book. One order per call; the controller fans out so a batch reports each
   * order's own outcome rather than one verdict for all of them.
   *
   * The pickup time is written BEFORE the booking is attempted, so a crash
   * between the two leaves the schedule intact and the shipment recoverable by
   * the normal reconciliation path instead of stranded.
   */
  async prepareForOrder(orderId: string, input: { service?: string; pickupAtIso: string }): Promise<ShipmentOutcome> {
    const pickupAt = new Date(input.pickupAtIso);
    if (Number.isNaN(pickupAt.getTime())) {
      return { ok: false, status: ShipmentStatus.PENDING, error: 'Pickup date and time are required' };
    }

    const shipment = await this.prisma.shipment.findUnique({ where: { orderId } });
    if (!shipment) throw new NotFoundException('Order has no shipment row');
    if (shipment.trackingNumber) {
      // Already booked — never book twice because an admin clicked again.
      return { ok: true, status: shipment.status, trackingNumber: shipment.trackingNumber };
    }

    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        metadata: withPickupDatetime(shipment.metadata, pickupAt.toISOString()),
        ...(input.service ? { service: input.service } : {}),
      },
    });

    return this.createForOrderSafe(orderId);
  }

  /** Admin retry: re-attempt creation for a FAILED (or not-yet-created) shipment. */
  async retry(orderId: string): Promise<ShipmentOutcome> {
    return this.createForOrderSafe(orderId);
  }

  /**
   * Admin operational action: cancel the booking WITH THE COURIER, then record it.
   *
   * Both providers have implemented `cancelShipment` since the shipment module
   * was written, but nothing ever called it — which is why `deleteShipment`
   * refuses a booked shipment ("there is no in-app way to undo the booking
   * first") and why an operator's only recourse was to hand-edit the status,
   * leaving the parcel live at the courier. This is that missing call.
   *
   * The courier goes FIRST and the local row is only touched once it accepted.
   * A cancellation the courier did not accept must never be recorded as one:
   * that is exactly the failure mode — a row saying CANCELLED while a real
   * parcel is still moving — that this endpoint exists to prevent.
   *
   * Deliberately NOT decided here (PAXELBOX-35 product decisions): Order.status
   * is untouched, no OrderEvent, no customer notification. This records that the
   * booking was withdrawn; what that means for the order and the customer is a
   * separate question with no repository evidence behind it yet.
   */
  async cancelForShipment(shipmentId: string): Promise<ShipmentOutcome> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Shipment not found');

    // Already withdrawn: report the existing state and make no courier call.
    // Mirrors the idempotent no-op that guards admin order-status updates.
    if (shipment.status === ShipmentStatus.CANCELLED) {
      return { ok: true, status: shipment.status, trackingNumber: shipment.trackingNumber ?? undefined };
    }

    // The provider contract cancels BY the courier's own handle. For both
    // providers that handle is what create returned (Paxel airwaybill_code,
    // JNE cnote_no), persisted here. Nothing else may stand in for it, and an
    // admin can never supply one — it is read from the row.
    const providerShipmentId = shipment.providerShipmentId;
    if (!providerShipmentId) {
      throw new ConflictException(
        'This shipment has no courier booking to cancel (no providerShipmentId). ' +
          'An unbooked draft can simply be deleted.',
      );
    }

    const provider = this.factory.get(shipment.provider);
    if (!provider) {
      // Same data defect the tracking worker reports: nothing in this build can
      // talk to that courier, so cancelling in-app is impossible.
      throw new ConflictException(
        `No provider registered for "${shipment.provider}"; this booking cannot be cancelled from the application.`,
      );
    }

    // Whether a courier will cancel a parcel that is already picked up or in
    // transit is the COURIER's rule, not one this repository states anywhere.
    // Rather than invent a local status matrix, the request is made and a
    // refusal propagates: executeShippingRequest raises PermanentError on 4xx
    // and TransientError on 5xx/timeout, and neither is swallowed.
    await provider.cancelShipment(providerShipmentId);

    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: ShipmentStatus.CANCELLED },
    });

    // The courier's last answer is now stale by definition.
    await this.invalidateTrackingCache(shipment.provider, shipment.trackingNumber);

    this.logger.log({
      event: 'shipment.cancelled',
      shipmentId: shipment.id,
      orderId: shipment.orderId,
      provider: shipment.provider,
      previousStatus: shipment.status,
    });

    return { ok: true, status: updated.status, trackingNumber: updated.trackingNumber ?? undefined };
  }

  /** Best-effort: a cache fault must never make a successful cancellation look failed. */
  private async invalidateTrackingCache(provider: string, trackingNumber: string | null): Promise<void> {
    if (!this.cache || !trackingNumber) return;
    try {
      await this.cache.del(trackingCacheKey(provider, trackingNumber));
    } catch {
      // The courier has already cancelled; a stale cache entry cannot undo that.
    }
  }

  /**
   * Background poll: advance non-terminal shipments by querying the courier, update
   * shipment + order status, and notify on delivery. Returns the number updated.
   */
  async pollAndUpdate(limit = 50): Promise<number> {
    const shipments = await this.prisma.shipment.findMany({
      where: { status: { in: NON_TERMINAL_TRACKING }, trackingNumber: { not: null } },
      include: {
        order: { include: { user: { select: { name: true, email: true, phone: true } }, address: { select: { phone: true } } } },
      },
      take: limit,
    });

    let updated = 0;
    for (const shipment of shipments) {
      const provider = this.factory.get(shipment.provider);
      if (!provider || !shipment.trackingNumber) continue;
      try {
        const result = await provider.trackShipment(shipment.trackingNumber);
        if (result.status === shipment.status) continue;

        await this.prisma.$transaction(async (tx) => {
          await tx.shipment.update({
            where: { id: shipment.id },
            data: { status: result.status, providerPayload: this.json(result.rawPayload) },
          });
          if (result.status === ShipmentStatus.DELIVERED) {
            // Legal-transition CAS (audit F4): never resurrect a CANCELLED order.
            const flip = await tx.order.updateMany({
              where: { id: shipment.orderId, status: { in: orderStatusSourcesFor(OrderStatus.DELIVERED) } },
              data: { status: OrderStatus.DELIVERED },
            });
            if (flip.count === 1) {
              await tx.orderEvent.create({
                data: { orderId: shipment.orderId, status: OrderStatus.DELIVERED, note: 'Delivered (courier tracking)' },
              });
              await this.enqueueWhatsApp(tx, 'order.delivered', shipment.order, {
                provider: shipment.provider,
                // Same precedence as order.shipped above: the label the customer
                // was quoted, then the paid code, and only then the shipment's
                // own snapshot. Shipment.service is a record, not the authority.
                service:
                  shipment.order.shippingServiceName ??
                  shipment.order.shippingService ??
                  shipment.service,
                tracking: shipment.trackingNumber ?? '',
              });
            }
          }
        });
        updated += 1;
      } catch (err) {
        this.logger.warn({ event: 'shipment.track_failed', shipmentId: shipment.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return updated;
  }

  /** Enqueue a WhatsApp notification row for the durable sender worker to deliver. */
  private async enqueueWhatsApp(
    tx: Prisma.TransactionClient,
    template: 'order.shipped' | 'order.delivered',
    order: {
      id: string;
      orderNumber: string;
      user?: { name: string; email: string; phone: string | null } | null;
      address?: { phone: string | null } | null;
    },
    vars: { provider: string; service: string; tracking: string },
  ): Promise<void> {
    const phone = order.address?.phone ?? order.user?.phone ?? null;
    await tx.notificationOutbox.create({
      data: {
        channel: NotificationChannel.WHATSAPP,
        recipient: phone ?? '',
        template,
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: order.user?.name ?? 'Pelanggan',
          customerPhone: phone,
          customerEmail: order.user?.email ?? null,
          shippingProvider: vars.provider,
          shippingService: vars.service,
          trackingNumber: vars.tracking,
        },
        sourceMessageId: randomUUID(),
      },
    });
  }
}
