import { Injectable, Optional } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, ReservationStatus } from '@prisma/client';
import { InventoryReservationService } from '../inventory/inventory-reservation.service';

type LockedPayment = { status: PaymentStatus; verifiedAt: Date | null };

/** Successful-payment evidence: PAID or REFUNDED (a refund implies payment), or verified. */
export function isPaid(payment: LockedPayment | null): boolean {
  if (!payment) return false;
  return payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.REFUNDED || payment.verifiedAt !== null;
}

/**
 * Single source of truth for cancelling an order and restoring its reserved
 * stock, shared by admin rejection/cancellation and automatic payment expiry.
 * Operates on the caller's transaction so cancellation composes atomically with
 * the payment transition + event that triggered it.
 */
@Injectable()
export class OrderCancellationService {
  // Optional: when present, cancellation RELEASES/EXPIRES reservations (restocking
  // only the committed portion). Absent (legacy/tests) → old item-based restock.
  constructor(@Optional() private readonly inventory?: InventoryReservationService) {}

  /**
   * Cancel an order exactly once. The CANCELLED transition is a CAS over the
   * active-status whitelist, so only the call that actually flips the order
   * restocks inventory and writes the cancellation event. Returns whether this
   * call performed the transition. `releaseStatus` controls the reservation
   * terminal state (RELEASED for cancel/reject, EXPIRED for payment expiry).
   */
  async cancelAndRestock(
    tx: Prisma.TransactionClient,
    orderId: string,
    note: string,
    releaseStatus: ReservationStatus = ReservationStatus.RELEASED,
  ): Promise<{ cancelled: boolean }> {
    // LOCK ORDER (P1.2.3): Payment row FIRST, then Order. Settlement, failure and
    // expiry all take the Payment row first (their status CAS) and the Order after,
    // so every path agrees on one order and cannot deadlock. For fail/expire the
    // lock is already held by the caller's CAS (re-locking is a no-op); for admin
    // cancellation it is what serializes this cancel against a concurrent settle:
    //  - settle first  -> this waits, then sees PAID: a paid cancellation keeps the
    //                     voucher consumed.
    //  - cancel first  -> settle waits on the Payment row, then finds the order
    //                     CANCELLED (its FOR UPDATE check) and rolls back: never PAID.
    // The paid/unpaid decision below is read UNDER this lock, so it cannot go stale.
    const payment = await this.lockPayment(tx, orderId);

    const flip = await tx.order.updateMany({
      where: {
        id: orderId,
        deletedAt: null,
        // Cancellable while active (pre-delivery); DELIVERED/COMPLETED are terminal.
        status: {
          in: [
            OrderStatus.PENDING,
            OrderStatus.PROCESSING,
            OrderStatus.PACKING,
            OrderStatus.SHIPPED,
            OrderStatus.DELIVERING,
          ],
        },
      },
      data: { status: OrderStatus.CANCELLED },
    });
    if (flip.count !== 1) {
      // Already cancelled (or terminal): nothing is restocked or released twice.
      return { cancelled: false };
    }
    await this.restock(tx, orderId, note, releaseStatus);
    // Voucher usage: released only for an UNPAID order. A paid order (later
    // cancelled or refunded) keeps its usage and New User redemption for good.
    if (!isPaid(payment)) {
      await this.releaseVoucher(tx, orderId);
    }
    await tx.orderEvent.create({ data: { orderId, status: OrderStatus.CANCELLED, note } });
    return { cancelled: true };
  }

  /** The order's Payment row, locked FOR UPDATE (null for legacy orders without one). */
  private async lockPayment(tx: Prisma.TransactionClient, orderId: string): Promise<LockedPayment | null> {
    const rows = await tx.$queryRaw<LockedPayment[]>(
      Prisma.sql`SELECT status, "verifiedAt" FROM "Payment" WHERE "orderId" = ${orderId} FOR UPDATE`,
    );
    return rows[0] ?? null;
  }

  /**
   * Release this order's voucher usage, exactly once, inside the cancellation
   * transaction. Runs only after the Order CAS above succeeded, so a repeated
   * cancellation or a duplicate callback never reaches it; the `releasedAt IS NULL`
   * guard makes the counter decrement a second, independent exactly-once gate.
   *
   * - VoucherUsage: soft-released (releasedAt set, row kept as history).
   * - Promo.currentUsageCount: decremented by one only when this call released the
   *   row, guarded > 0. A counter that cannot be decremented is an inconsistency:
   *   the whole cancellation (order, stock, voucher) rolls back rather than leaving
   *   a half-released state.
   * - NewUserVoucherRedemption: deleted, freeing the account's single New User slot.
   */
  private async releaseVoucher(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    const usage = await tx.voucherUsage.findUnique({ where: { orderId }, select: { voucherId: true } });
    if (usage) {
      const released = await tx.voucherUsage.updateMany({
        where: { orderId, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      if (released.count === 1) {
        const decremented = await tx.promo.updateMany({
          where: { id: usage.voucherId, currentUsageCount: { gt: 0 } },
          data: { currentUsageCount: { decrement: 1 } },
        });
        if (decremented.count !== 1) {
          throw new Error(
            `Voucher usage counter for promo ${usage.voucherId} is already 0; refusing a partial release of order ${orderId}`,
          );
        }
      }
    }
    await tx.newUserVoucherRedemption.deleteMany({ where: { orderId } });
  }

  /**
   * Restore inventory for a cancelled order. With reservations (new model): release
   * them — COMMITTED reservations restock (stock was deducted at commit), RESERVED
   * ones just free the hold. Without reservations (legacy orders / no inventory
   * service): increment product.stock from order items (inverse of the old
   * checkout decrement).
   */
  private async restock(
    tx: Prisma.TransactionClient,
    orderId: string,
    note: string,
    releaseStatus: ReservationStatus,
  ): Promise<void> {
    if (this.inventory) {
      await this.inventory.releaseForOrder(tx, orderId, releaseStatus, note);
      // The legacy fallback below is ONLY for pre-reservation orders (their stock
      // was decremented at checkout). A reservation-era order whose reservations
      // are already terminal (e.g. expired by the reservation worker before this
      // cancellation) must NOT fall through — RESERVED never deducted stock, so
      // the fallback increment would inflate inventory (audit F2).
      const reservationRows = await tx.inventoryReservation.count({ where: { orderId } });
      if (reservationRows > 0) return;
    }
    // Legacy fallback (pre-reservation orders only).
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, quantity: true } });
    const quantityByProduct = new Map<string, number>();
    for (const item of items) {
      quantityByProduct.set(item.productId, (quantityByProduct.get(item.productId) ?? 0) + item.quantity);
    }
    for (const [productId, quantity] of quantityByProduct) {
      await tx.product.updateMany({ where: { id: productId }, data: { stock: { increment: quantity } } });
    }
  }
}
