/**
 * Usage column for the voucher list: "<used> / <limit>".
 *
 * `maxUsageCount` is a LIMIT, and the backend reads it that way everywhere:
 * `null` means unlimited, and any number — including 0 — is enforced as
 * `currentUsageCount >= maxUsageCount` at checkout, at redemption, in the
 * storefront GET /catalog/promos filter and in the dashboard's valid-voucher
 * count. So 0 means "no uses allowed", NOT "unlimited".
 *
 * Test for null/undefined, never truthiness: `0` is falsy, and the previous
 * `maxUsageCount ? … : '∞'` rendered a zero-use voucher as "0 / ∞" — identical
 * to a genuinely unlimited one — while it was hidden from the homepage and
 * rejected at checkout (P1 #12).
 */
export function formatPromoUsage(
  currentUsageCount: number,
  maxUsageCount: number | null | undefined,
): string {
  return maxUsageCount == null
    ? `${currentUsageCount} / ∞`
    : `${currentUsageCount} / ${maxUsageCount}`;
}
