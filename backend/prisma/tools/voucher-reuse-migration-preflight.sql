-- P1.2.2 voucher migration — READ-ONLY preflight for migration 20261113090000
-- (20261113090000_voucher_reuse_new_user_redemption).
--
-- That migration starts with a guard (its step 0, a DO block) that RAISES — and so
-- rolls the whole migration back — when existing Promo usage counters would violate
-- the two CHECK constraints it adds in step 3. This script evaluates exactly the
-- same two conditions, without running the migration, so an operator can resolve
-- the offending promos BEFORE deploying.
--
-- It reports, it never repairs: no counter, limit or usage row is changed.
--
-- Run it with psql (the \echo lines are psql meta-commands), with credentials that
-- can SELECT only, against the database you are assessing:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/tools/voucher-reuse-migration-preflight.sql
--
-- Write safety: one READ ONLY transaction (PostgreSQL rejects any write or DDL in
-- it), REPEATABLE READ (one snapshot for every section), statement_timeout and
-- lock_timeout, ROLLBACK at the end, ON_ERROR_STOP on any error.
--
-- Output: promo id, code and title, flags, counters and counts only. No user,
-- order, payment or customer data is selected.
--
-- The guard, verbatim from the migration's executable SQL:
--   negative_count := COUNT(*) FROM "Promo" WHERE "currentUsageCount" < 0
--   over_max_count := COUNT(*) FROM "Promo"
--                       WHERE "maxUsageCount" IS NOT NULL
--                         AND "currentUsageCount" > "maxUsageCount"
--   RAISE EXCEPTION when negative_count > 0 OR over_max_count > 0
-- No other filter: soft-deleted, inactive and expired promos are all included.
-- "currentUsageCount" is INTEGER NOT NULL (no NULL case); "maxUsageCount" is
-- nullable (NULL = unlimited, never "over max") and already CHECKed >= 0, so a
-- negative counter can never also be above its maximum.
--
-- The migration's other data-dependent statements cannot fail independently:
--   * its CHECK constraints (step 3) are logically identical to the guard;
--   * its New User backfill (step 4) reads VoucherUsage rows whose voucherId,
--     userId and orderId are already enforced by foreign keys, picks one row per
--     user (DISTINCT ON) and VoucherUsage.orderId is already unique.
-- Its schema statements (DROP INDEX, ADD COLUMN, CREATE TABLE) can only fail if
-- the schema already differs — see section 0.

\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 0. Migration state (informational)
--    Before the migration : all false except old_unique_index_exists = true.
--    After the migration  : all true  except old_unique_index_exists = false;
--                           then the guard is moot (the CHECKs already hold).
--    Any other combination means the schema has drifted from the migration
--    history: stop and investigate before deploying.
-- ============================================================================

\echo '== 0. Migration state (informational)'
SELECT to_regclass('"NewUserVoucherRedemption"') IS NOT NULL                 AS redemption_table_exists,
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = '"Promo"'::regclass
                 AND conname = 'Promo_currentUsageCount_nonneg')             AS nonneg_check_exists,
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = '"Promo"'::regclass
                 AND conname = 'Promo_currentUsageCount_within_max')         AS within_max_check_exists,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = 'VoucherUsage' AND column_name = 'releasedAt') AS released_at_column_exists,
       to_regclass('"VoucherUsage_voucherId_userId_key"') IS NOT NULL         AS old_unique_index_exists;

-- ============================================================================
-- 1. Migration guard — exact replica (BLOCKING)
--    guard_verdict = BLOCKED means `prisma migrate deploy` will stop at this
--    migration with "P1.2.2 preflight failed: …" and change nothing. Resolve every
--    promo listed in section 2 first (a business decision; this script suggests
--    nothing automatically), then re-run this preflight until it says PASS.
-- ============================================================================

\echo '== 1. Migration guard (BLOCKING)'
SELECT g.negative_count,
       g.over_max_count,
       CASE WHEN g.negative_count > 0 OR g.over_max_count > 0
            THEN 'BLOCKED - the migration guard will raise and roll the migration back'
            ELSE 'PASS - the migration guard will not raise' END AS guard_verdict
FROM (
  SELECT (SELECT count(*) FROM "Promo" WHERE "currentUsageCount" < 0) AS negative_count,
         (SELECT count(*) FROM "Promo"
          WHERE "maxUsageCount" IS NOT NULL AND "currentUsageCount" > "maxUsageCount") AS over_max_count
) g;

-- ============================================================================
-- 2. The promos that trip the guard (BLOCKING detail)
--    negative_counter : currentUsageCount < 0. The application never decrements
--                       below zero; this comes from a manual edit or an import.
--    above_max        : currentUsageCount > maxUsageCount. Typically an admin
--                       lowered the limit below the usage already counted (the
--                       pre-P1 admin form did not prevent it), e.g. to close a
--                       voucher early. over_by = how far above the limit.
--    State columns (is_active, soft_deleted, expired) do NOT exempt a promo: the
--    guard counts every row. voucher_usage_rows = recorded usages of the promo,
--    as evidence for the decision.
-- ============================================================================

\echo '== 2. Promos that trip the guard (BLOCKING detail)'
SELECT CASE WHEN pr."currentUsageCount" < 0 THEN 'negative_counter' ELSE 'above_max' END AS anomaly,
       pr.id                                                   AS promo_id,
       pr.code,
       pr.title,
       pr."isActive"                                           AS is_active,
       (pr."deletedAt" IS NOT NULL)                            AS soft_deleted,
       (pr."endDate" IS NOT NULL AND pr."endDate" < now())     AS expired,
       pr."isNewUserOnly"                                      AS new_user_only,
       pr."currentUsageCount"                                  AS current_usage_count,
       pr."maxUsageCount"                                      AS max_usage_count,
       CASE WHEN pr."currentUsageCount" >= 0
            THEN pr."currentUsageCount" - pr."maxUsageCount" END AS over_by,
       (SELECT count(*) FROM "VoucherUsage" u WHERE u."voucherId" = pr.id) AS voucher_usage_rows,
       pr."updatedAt"                                          AS promo_updated_at
FROM "Promo" pr
WHERE pr."currentUsageCount" < 0
   OR (pr."maxUsageCount" IS NOT NULL AND pr."currentUsageCount" > pr."maxUsageCount")
ORDER BY anomaly, over_by DESC NULLS LAST, pr.code;

-- ============================================================================
-- 3. Counter overview (informational)
--    Shows the guard's boundary: at_limit (current = max, an exhausted voucher)
--    is VALID and does not block; only strictly above the limit does.
-- ============================================================================

\echo '== 3. Counter overview (informational)'
SELECT CASE WHEN "currentUsageCount" < 0                                   THEN '1 negative (BLOCKING)'
            WHEN "maxUsageCount" IS NULL                                   THEN '4 unlimited (max NULL)'
            WHEN "currentUsageCount" > "maxUsageCount"                     THEN '2 above max (BLOCKING)'
            WHEN "currentUsageCount" = "maxUsageCount"                     THEN '3 at limit (valid, exhausted)'
            ELSE '5 below limit (valid)' END                             AS counter_state,
       count(*)                                                          AS promos,
       count(*) FILTER (WHERE "deletedAt" IS NOT NULL)                   AS soft_deleted,
       count(*) FILTER (WHERE NOT "isActive")                            AS inactive,
       count(*) FILTER (WHERE "endDate" IS NOT NULL AND "endDate" < now()) AS expired
FROM "Promo"
GROUP BY 1
ORDER BY 1;

-- ============================================================================
-- 4. Post-migration release capacity (INFORMATIONAL — NOT a migration blocker)
--    The migration does not check this, and it does not affect the PASS/BLOCKED
--    verdict in section 1.
--    After the migration, IF an UNPAID order is later cancelled (or its payment
--    expires), its voucher usage is released and the promo counter is decremented
--    by one, guarded by currentUsageCount > 0 (OrderCancellationService
--    .releaseVoucher); if that guard fails, the cancellation / payment expiry rolls
--    back and keeps failing. "Potentially releasable" usages are those that COULD
--    be released that way: order not soft-deleted and still in a cancellable
--    status (PENDING, PROCESSING, PACKING, SHIPPED, DELIVERING), payment absent or
--    not paid (not PAID/REFUNDED and no verifiedAt). A promo whose counter is
--    smaller than that number could make some of those future cancellations fail,
--    but only if that many of them are actually cancelled. Review only.
--    Meaningful BEFORE the migration (section 0): it does not know about usages a
--    migrated database has already released.
-- ============================================================================

\echo '== 4. Post-migration release capacity (informational, not a migration blocker)'
WITH potentially_releasable AS (
  SELECT u."voucherId" AS promo_id, count(*) AS potentially_releasable_usages
  FROM "VoucherUsage" u
  JOIN "Order" o ON o.id = u."orderId"
  LEFT JOIN "Payment" p ON p."orderId" = o.id
  WHERE o."deletedAt" IS NULL
    AND o.status IN ('PENDING', 'PROCESSING', 'PACKING', 'SHIPPED', 'DELIVERING')
    AND NOT (coalesce(p.status IN ('PAID', 'REFUNDED'), false) OR p."verifiedAt" IS NOT NULL)
  GROUP BY 1
)
SELECT pr.id AS promo_id, pr.code, pr."currentUsageCount" AS current_usage_count,
       r.potentially_releasable_usages,
       r.potentially_releasable_usages - pr."currentUsageCount" AS potential_release_shortfall
FROM potentially_releasable r
JOIN "Promo" pr ON pr.id = r.promo_id
WHERE r.potentially_releasable_usages > pr."currentUsageCount"
ORDER BY potential_release_shortfall DESC, pr.code;

ROLLBACK;
