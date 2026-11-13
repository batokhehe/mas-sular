import { Prisma } from '@prisma/client';

/**
 * Voucher rule messages shared by the pre-transaction availability gate and the
 * in-transaction reservation, so a request that loses a race gets the SAME
 * friendly 400 as one refused up front - never a raw database error / 500.
 */
export const VOUCHER_LIMIT_REACHED = 'Voucher usage limit has been reached';
export const NEW_CUSTOMERS_ONLY = 'Voucher is only available for new customers';
export const NEW_USER_VOUCHER_ALREADY_REDEEMED = 'A new customer voucher can only be used once per account';

/** Database CHECK constraints added by migration 20261113090000. */
export const PROMO_COUNTER_WITHIN_MAX = 'Promo_currentUsageCount_within_max';
export const PROMO_COUNTER_NONNEG = 'Promo_currentUsageCount_nonneg';

/** Prisma P2025: the conditional `update` matched no row (e.g. quota already full). */
export function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** Prisma P2002 on a unique constraint covering `field`. */
export function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : target != null ? [String(target)] : [];
  return fields.some((f) => f === field || f.includes(field));
}

/**
 * A violated database CHECK constraint, identified by name. Prisma surfaces
 * PostgreSQL 23514 as a request error whose message (and, depending on the
 * engine path, meta) names the constraint, so the name is the reliable signal.
 */
export function isCheckViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes(constraint)) return true;
  const meta = (err as { meta?: unknown }).meta;
  return meta !== undefined && JSON.stringify(meta).includes(constraint);
}
