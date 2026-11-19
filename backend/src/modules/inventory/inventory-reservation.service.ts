import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ListReservationsQueryDto } from './application/dto/inventory-reservation-query.dto';
import { pageArgs, paginate } from '../../common/pagination/pagination';
import { positiveInt } from '../../common/utils/number.util';
import { InventoryCoverageError, InventoryCoverageShortfall } from './inventory-coverage.error';
import { loadAvailableStock } from './stock-availability';

/**
 * C1-a: payment states in which the customer may still pay (or an uploaded receipt
 * is still awaiting verification). While the order's payment is in one of these,
 * its reservations must stay RESERVED: expiring them would let a later settlement
 * mark the payment PAID without deducting stock (audit finding H1). Mirrors
 * EXPIRY_ELIGIBLE_STATUSES in PaymentSettlementService, which is kept separate to
 * avoid a payments → inventory → payments import cycle.
 */
export const PAYMENT_AWAITING_STATUSES: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.WAITING_VERIFICATION,
];

/** Result of the post-commit coverage check (C1-a B guard). */
export type CoverageResult =
  /** The order has no reservation rows at all: a legacy order, checked as before. */
  | { mode: 'LEGACY_NO_RESERVATIONS' }
  /** Every ordered product is fully covered by COMMITTED reservations. */
  | { mode: 'COVERED'; products: number };

const ADMIN_INCLUDE = {
  order: { select: { id: true, orderNumber: true, user: { select: { id: true, name: true, email: true } } } },
  product: { select: { id: true, name: true } },
  outlet: { select: { id: true, name: true } },
} as const;

export interface ReservationItem {
  productId: string;
  quantity: number;
}

export interface ReserveArgs {
  orderId: string;
  items: ReservationItem[];
  paymentMethod: PaymentMethod;
  /** Allocated outlet (multi-outlet). When absent, the active outlet is used. Stock
   *  is ALWAYS the outlet's Stok Produk row (ProductInventory), never Product.stock. */
  outletId?: string | null;
}

/**
 * Stock reservation ledger over the "Stok Produk" inventory (ProductInventory).
 * Available stock = ProductInventory.stock - ProductInventory.reserved at the outlet.
 * Reservations are created at checkout (reserved += qty), COMMITTED at payment
 * verification (stock -= qty, reserved -= qty), and RELEASED/EXPIRED on
 * cancel/expiry. New reservations never use the master Product.stock; the legacy
 * Product.stock branches in commit/release remain only so reservations created
 * before this rule still settle consistently.
 */
@Injectable()
export class InventoryReservationService {
  private readonly logger = new Logger('InventoryReservationService');

  constructor(private readonly prisma: PrismaService) {}

  /** Reservation expiry = payment expiry window (null for methods that never expire). */
  reservationExpiry(method: PaymentMethod, from = new Date()): Date | null {
    if (method === PaymentMethod.BANK_TRANSFER || method === PaymentMethod.QRIS) {
      return new Date(from.getTime() + positiveInt(process.env.PAYMENT_EXPIRY_MS, 24 * 60 * 60 * 1000));
    }
    if (method === PaymentMethod.GATEWAY) {
      const ms = positiveInt(process.env.PAYMENT_GATEWAY_EXPIRY_MS, 0);
      return ms > 0 ? new Date(from.getTime() + ms) : null;
    }
    return null; // COD never expires
  }

  /** Non-locking available-stock read for previews (Stok Produk only; see stock-availability.ts). */
  async availableFor(productId: string): Promise<number> {
    return (await this.availableByProduct([productId])).get(productId) ?? 0;
  }

  /** Non-locking availability per product from Stok Produk (best single active outlet). */
  availableByProduct(productIds: readonly string[]): Promise<Map<string, number>> {
    return loadAvailableStock(this.prisma, productIds);
  }

  /**
   * Reserve stock for every order item in the caller's transaction. Each product
   * row is locked FOR UPDATE so concurrent checkouts serialize; insufficient
   * available stock throws, rolling back the whole checkout.
   *
   * Serialising on the product row is necessary but NOT sufficient on its own:
   * everything the availability predicate reads must also be a current read.
   * Both branches below therefore read their held quantity with FOR UPDATE
   * rather than through a snapshot query — see BF-017.
   */
  async reserveForOrder(tx: Prisma.TransactionClient, args: ReserveArgs): Promise<void> {
    const expiresAt = this.reservationExpiry(args.paymentMethod);
    const legacyOutletId = args.outletId
      ? null
      : (await tx.outlet.findFirst({ where: { isActive: true }, select: { id: true } }))?.id ?? null;

    const qtyByProduct = new Map<string, number>();
    for (const item of args.items) {
      qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    }

    // Deterministic lock order (ascending productId): every checkout acquires its
    // FOR UPDATE locks in the same sequence regardless of cart item order, so two
    // carts with the same products in reversed order can never deadlock (H1).
    const orderedProducts = [...qtyByProduct.entries()].sort(([a], [b]) => a.localeCompare(b));

    // The outlet whose Stok Produk is reserved: the allocated one, else the active
    // outlet. Never the master Product.stock (business rule: Stok Produk only).
    const outletId = args.outletId ?? legacyOutletId;

    for (const [productId, quantity] of orderedProducts) {
      const pi = outletId
        ? await tx.productInventory.findUnique({ where: { productId_outletId: { productId, outletId } } })
        : null;
      // No Stok Produk row at the fulfilling outlet = no stock there.
      if (!outletId || !pi) throw new BadRequestException('Insufficient available stock');

      // Current read under a row lock: concurrent checkouts serialize here (H1/BF-017).
      const rows = await tx.$queryRaw<Array<{ stock: number; reserved: number }>>(
        Prisma.sql`SELECT stock, reserved FROM "ProductInventory" WHERE id = ${pi.id} FOR UPDATE`,
      );
      const row = rows[0];
      const available = (row?.stock ?? 0) - (row?.reserved ?? 0);
      if (!row || available < quantity) throw new BadRequestException('Insufficient available stock');

      await tx.productInventory.update({
        where: { id: pi.id },
        data: { reserved: { increment: quantity }, available: (row.stock - row.reserved) - quantity },
      });
      const reservation = await tx.inventoryReservation.create({
        // inventoryHoldApplied: this row's hold was placed above, in this transaction.
        data: { orderId: args.orderId, productId, outletId, reservedQty: quantity, status: ReservationStatus.RESERVED, expiresAt, inventoryHoldApplied: true },
      });
      await this.addHistory(tx, reservation.id, ReservationStatus.RESERVED, 'Reservation created');
    }
  }

  /**
   * Commit every RESERVED reservation for an order and mark it COMMITTED. Called
   * after payment is verified. A reservation that holds Stok Produk
   * (inventoryHoldApplied) deducts that row's stock and frees its hold; a legacy
   * reservation deducts Product.stock, exactly as before.
   *
   * C2: the RESERVED → COMMITTED transition is a per-row CAS. A reservation the
   * expiry worker flipped to EXPIRED between our snapshot read and this write
   * loses the CAS and is SKIPPED — never resurrected, never double-counted.
   */
  async commitForOrder(tx: Prisma.TransactionClient, orderId: string, note = 'Committed on payment verified'): Promise<number> {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId, status: ReservationStatus.RESERVED },
    });
    let committed = 0;
    for (const r of reservations) {
      const flip = await tx.inventoryReservation.updateMany({
        where: { id: r.id, status: ReservationStatus.RESERVED },
        data: { status: ReservationStatus.COMMITTED, committedQty: r.reservedQty },
      });
      if (flip.count !== 1) {
        this.logger.warn(`reservation ${r.id} left RESERVED before commit (expired concurrently) — skipped`);
        continue; // stock/hold already handled by whoever won the transition
      }

      const hold = await this.holdFor(tx, r);
      if (hold.kind === 'held') {
        // Deduct outlet stock and release this reservation's hold. `available` is
        // recomputed from the FOR UPDATE row (C5): (stock−q) − (reserved−q).
        await tx.productInventory.update({
          where: { id: hold.pi.id },
          data: { stock: { decrement: r.reservedQty }, reserved: { decrement: r.reservedQty }, available: hold.pi.stock - hold.pi.reserved },
        });
      } else if (hold.kind === 'legacy') {
        await tx.product.update({ where: { id: r.productId }, data: { stock: { decrement: r.reservedQty } } });
      }
      await this.addHistory(tx, r.id, ReservationStatus.COMMITTED, note);
      committed += 1;
    }
    return committed;
  }

  /**
   * C1-a B guard. Run INSIDE the settlement transaction, after commitForOrder:
   * verifies that the order's COMMITTED reservations cover every ordered product
   * in full. Quantities are compared per product (order items for the same product
   * are summed, matching reserveForOrder's one-row-per-product aggregation), and
   * the check is the same for the legacy Product.stock and the per-outlet
   * ProductInventory models because it reads only the reservation ledger.
   *
   * - No reservation rows at all → a legacy order (created before reservations
   *   existed, or without the inventory module): returned as-is, behaviour
   *   unchanged.
   * - Reservation rows exist but any product is under- or over-committed
   *   (including zero committed because every row EXPIRED/RELEASED) → throws
   *   InventoryCoverageError, which aborts and rolls back the whole settlement.
   */
  async assertCommittedCoverage(tx: Prisma.TransactionClient, orderId: string): Promise<CoverageResult> {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId },
      select: { productId: true, status: true, committedQty: true },
    });
    if (reservations.length === 0) return { mode: 'LEGACY_NO_RESERVATIONS' };

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { productId: true, quantity: true },
    });

    const required = new Map<string, number>();
    for (const item of items) {
      required.set(item.productId, (required.get(item.productId) ?? 0) + item.quantity);
    }
    const committed = new Map<string, number>();
    for (const r of reservations) {
      if (r.status !== ReservationStatus.COMMITTED) continue;
      committed.set(r.productId, (committed.get(r.productId) ?? 0) + r.committedQty);
    }

    const shortfalls: InventoryCoverageShortfall[] = [];
    const productIds = [...new Set([...required.keys(), ...committed.keys()])].sort();
    for (const productId of productIds) {
      const need = required.get(productId) ?? 0;
      const have = committed.get(productId) ?? 0;
      if (need !== have) shortfalls.push({ productId, required: need, committed: have });
    }
    if (shortfalls.length > 0) {
      this.logger.warn(`order ${orderId} settlement blocked: committed reservations do not cover the order (${shortfalls.length} product(s))`);
      throw new InventoryCoverageError(orderId, shortfalls);
    }
    return { mode: 'COVERED', products: required.size };
  }

  /**
   * Where a reservation's counters live, decided by the reservation's OWN record
   * (inventoryHoldApplied) - never by whether a ProductInventory row happens to
   * exist now (a legacy reservation settled after its product gained a Stok Produk
   * row used to decrement a hold it never placed: production drift on 11699095).
   * - 'held': the row this reservation holds, locked FOR UPDATE (C5) so `available`
   *   is recomputed from current, serialized values.
   * - 'legacy': no ProductInventory hold; Product.stock semantics, as before.
   * - 'missing': it held a row that no longer exists (deleted with its outlet or
   *   product). Nothing is moved - and never the master stock instead.
   */
  private async holdFor(
    tx: Prisma.TransactionClient,
    r: { id: string; productId: string; outletId: string | null; inventoryHoldApplied: boolean },
  ): Promise<{ kind: 'held'; pi: { id: string; stock: number; reserved: number } } | { kind: 'legacy' } | { kind: 'missing' }> {
    if (!r.inventoryHoldApplied) return { kind: 'legacy' };
    const rows = r.outletId
      ? await tx.$queryRaw<Array<{ id: string; stock: number; reserved: number }>>(
          Prisma.sql`SELECT id, stock, reserved FROM "ProductInventory"
                     WHERE "productId" = ${r.productId} AND "outletId" = ${r.outletId} FOR UPDATE`,
        )
      : [];
    if (!rows[0]) {
      this.logger.error(`reservation ${r.id} holds Stok Produk but its ProductInventory row is gone - counters not moved`);
      return { kind: 'missing' };
    }
    return { kind: 'held', pi: rows[0] };
  }

  /**
   * Release active reservations for an order. COMMITTED reservations restock where
   * their commit deducted (the held Stok Produk row, or Product.stock for a legacy
   * reservation); RESERVED ones free their hold (legacy ones held nothing).
   * Returns whether any reservation existed (so legacy orders fall back to the
   * old restock path).
   */
  async releaseForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    status: ReservationStatus = ReservationStatus.RELEASED,
    note = 'Reservation released',
  ): Promise<{ handled: boolean }> {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId, status: { in: [ReservationStatus.RESERVED, ReservationStatus.COMMITTED] } },
    });
    for (const found of reservations) {
      // The status OBSERVED before the CAS decides which counters move (never re-read).
      const r = { ...found };
      const releasedQty = r.status === ReservationStatus.COMMITTED ? r.committedQty : r.reservedQty;
      // CAS on the OBSERVED status (C2-style): if the expiry worker (or a
      // concurrent commit) transitioned this row after our snapshot read, skip it
      // — the winner already adjusted stock/hold, touching counters again would
      // corrupt them.
      const flip = await tx.inventoryReservation.updateMany({
        where: { id: r.id, status: r.status },
        data: { status, releasedQty },
      });
      if (flip.count !== 1) {
        this.logger.warn(`reservation ${r.id} changed state before release — skipped`);
        continue;
      }

      const hold = await this.holdFor(tx, r);
      if (hold.kind === 'held') {
        const pi = hold.pi;
        // COMMITTED → restock the outlet; RESERVED → free this reservation's hold.
        // `available` recomputed from the FOR UPDATE row (C5).
        if (r.status === ReservationStatus.COMMITTED && r.committedQty > 0) {
          await tx.productInventory.update({
            where: { id: pi.id },
            data: { stock: { increment: r.committedQty }, available: pi.stock + r.committedQty - pi.reserved },
          });
        } else if (r.status === ReservationStatus.RESERVED) {
          await tx.productInventory.update({
            where: { id: pi.id },
            data: { reserved: { decrement: r.reservedQty }, available: pi.stock - (pi.reserved - r.reservedQty) },
          });
        }
      } else if (hold.kind === 'legacy' && r.status === ReservationStatus.COMMITTED && r.committedQty > 0) {
        await tx.product.update({ where: { id: r.productId }, data: { stock: { increment: r.committedQty } } });
      }
      await this.addHistory(tx, r.id, status, note);
    }
    return { handled: reservations.length > 0 };
  }

  /**
   * Worker: CAS-expire a single RESERVED reservation (concurrency-safe).
   *
   * C1-a Option A: the order's Payment row is locked FOR UPDATE BEFORE the
   * reservation is touched. That is the same first lock settle(), expire() and
   * cancelAndRestock() take, so this transaction and a settlement for the same
   * order are strictly serialized:
   * - payment still PENDING / WAITING_VERIFICATION → the customer can still pay,
   *   so the reservation is left RESERVED (returns false). Payment expiry, not this
   *   worker, owns the release for such orders.
   * - payment terminal (PAID / FAILED / EXPIRED / REFUNDED), soft-deleted, or no
   *   payment at all (orphan / legacy) → the existing CAS expiry runs unchanged, as
   *   the safety net.
   * Lock order: Payment → InventoryReservation → ProductInventory, a prefix-
   * compatible subset of settlement's Payment → Order → InventoryReservation →
   * ProductInventory/Product, so no new lock cycle is introduced.
   */
  async expireReservation(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Lock ONLY the payment row (FOR UPDATE OF p), found through the reservation's
      // immutable orderId. No row → orphan reservation (no payment): proceed.
      const payments = await tx.$queryRaw<Array<{ status: PaymentStatus; deletedAt: Date | null }>>(
        Prisma.sql`SELECT p.status, p."deletedAt" FROM "Payment" p
                   JOIN "InventoryReservation" r ON r."orderId" = p."orderId"
                   WHERE r.id = ${id}
                   FOR UPDATE OF p`,
      );
      const payment = payments[0];
      if (payment && !payment.deletedAt && PAYMENT_AWAITING_STATUSES.includes(payment.status)) {
        return false; // still payable: keep the stock held for it
      }

      const flip = await tx.inventoryReservation.updateMany({
        where: { id, status: ReservationStatus.RESERVED },
        data: { status: ReservationStatus.EXPIRED },
      });
      if (flip.count !== 1) return false;

      const row = await tx.inventoryReservation.findUnique({
        where: { id },
        select: { id: true, reservedQty: true, productId: true, outletId: true, inventoryHoldApplied: true },
      });
      const reservedQty = row?.reservedQty ?? 0;

      // Free THIS reservation's hold so ProductInventory.available recovers. A
      // RESERVED reservation never deducted stock, so only `reserved` is freed
      // (stock unchanged). A legacy reservation held nothing in ProductInventory and
      // frees nothing there - even if its product has a Stok Produk row today.
      // Row locked FOR UPDATE (C5) so `available` is recomputed from current values.
      const hold = row ? await this.holdFor(tx, row) : ({ kind: 'legacy' } as const);
      if (hold.kind === 'held') {
        await tx.productInventory.update({
          where: { id: hold.pi.id },
          data: { reserved: { decrement: reservedQty }, available: hold.pi.stock - (hold.pi.reserved - reservedQty) },
        });
      }

      await tx.inventoryReservation.update({ where: { id }, data: { releasedQty: reservedQty } });
      await this.addHistory(tx, id, ReservationStatus.EXPIRED, 'Expired by reservation worker');
      return true;
    });
  }

  private async addHistory(
    tx: Prisma.TransactionClient,
    reservationId: string,
    status: ReservationStatus,
    note?: string,
  ): Promise<void> {
    await tx.inventoryReservationHistory.create({ data: { reservationId, status, note } });
  }

  // ---------------- Admin reads ----------------

  async listReservations(query: ListReservationsQueryDto) {
    const term = query.search?.trim();
    const { skip, take, page, limit } = pageArgs(query);
    const where: Prisma.InventoryReservationWhereInput = {
      status: query.status,
      outletId: query.outletId,
      ...(query.expired ? { expiresAt: { not: null, lte: new Date() } } : {}),
      ...(term
        ? {
            OR: [
              { order: { orderNumber: { contains: term } } },
              { product: { name: { contains: term } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.inventoryReservation.findMany({
        where,
        include: ADMIN_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.inventoryReservation.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async getReservation(id: string) {
    const reservation = await this.prisma.inventoryReservation.findUnique({
      where: { id },
      include: { ...ADMIN_INCLUDE, history: { orderBy: { createdAt: 'asc' } } },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }
}
