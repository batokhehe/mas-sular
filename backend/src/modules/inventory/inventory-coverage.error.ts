import { ConflictException } from '@nestjs/common';

/** One product whose committed reservation quantity does not match the order. */
export interface InventoryCoverageShortfall {
  productId: string;
  /** Σ OrderItem.quantity for this product. */
  required: number;
  /** Σ committedQty of this order's COMMITTED reservations for this product. */
  committed: number;
}

/**
 * C1-a B guard: settlement tried to mark a payment PAID, but the order's
 * reservations do not cover what was ordered (for example they expired before the
 * payment arrived). The settlement transaction is aborted by this error, so the
 * payment, the order transition, the reservation commits and the outbox event all
 * roll back together.
 *
 * It extends ConflictException so existing HTTP callers (admin verify) keep their
 * 409 behaviour, but it is a dedicated type: callers that must react to a coverage
 * failure specifically (the gateway applier records an incident) test for THIS
 * class instead of reinterpreting unrelated ConflictExceptions.
 */
export class InventoryCoverageError extends ConflictException {
  readonly code = 'INVENTORY_COVERAGE_MISMATCH';

  constructor(
    readonly orderId: string,
    readonly shortfalls: InventoryCoverageShortfall[],
  ) {
    super('Order stock is no longer reserved; the payment cannot be settled automatically');
    this.name = 'InventoryCoverageError';
  }
}
