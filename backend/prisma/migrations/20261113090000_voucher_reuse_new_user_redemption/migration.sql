-- P1.2.2: voucher reuse + one New User redemption per account.
--
-- Approved rules:
--   * Regular vouchers may be reused by the same user across orders, so the
--     (voucherId, userId) uniqueness is dropped; VoucherUsage.orderId stays unique.
--   * A user may hold ONE New User redemption across ALL New User promos for the
--     lifetime of the account (NewUserVoucherRedemption.userId is unique).
--   * Unpaid cancelled/expired/failed orders release usage: VoucherUsage.releasedAt
--     (soft release, row kept). The release lifecycle itself ships in P1.2.3.
--   * Historical usage rows are never deleted; historical counters are NOT corrected.
--
-- Additive except for the dropped unique index. Runs in one transaction (prisma migrate).

-- 0. Stop, rather than modify data, if existing counters would violate the new
--    checks. The migration then rolls back as a whole and nothing changes.
DO $$
DECLARE
  negative_count  INTEGER;
  over_max_count  INTEGER;
BEGIN
  SELECT COUNT(*) INTO negative_count FROM "Promo" WHERE "currentUsageCount" < 0;
  SELECT COUNT(*) INTO over_max_count FROM "Promo"
    WHERE "maxUsageCount" IS NOT NULL AND "currentUsageCount" > "maxUsageCount";
  IF negative_count > 0 OR over_max_count > 0 THEN
    RAISE EXCEPTION 'P1.2.2 preflight failed: % promo(s) with negative currentUsageCount, % promo(s) with currentUsageCount above maxUsageCount. Historical counters are not corrected automatically; resolve explicitly before migrating.',
      negative_count, over_max_count;
  END IF;
END $$;

-- 1. Regular voucher reuse: drop per-user uniqueness, keep a lookup index.
-- DropIndex
DROP INDEX "VoucherUsage_voucherId_userId_key";

-- AlterTable
ALTER TABLE "VoucherUsage" ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "VoucherUsage_voucherId_userId_idx" ON "VoucherUsage"("voucherId", "userId");

-- 2. One New User redemption per account, across all New User promos.
-- CreateTable
CREATE TABLE "NewUserVoucherRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewUserVoucherRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewUserVoucherRedemption_userId_key" ON "NewUserVoucherRedemption"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NewUserVoucherRedemption_orderId_key" ON "NewUserVoucherRedemption"("orderId");

-- CreateIndex
CREATE INDEX "NewUserVoucherRedemption_promoId_idx" ON "NewUserVoucherRedemption"("promoId");

-- AddForeignKey
ALTER TABLE "NewUserVoucherRedemption" ADD CONSTRAINT "NewUserVoucherRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewUserVoucherRedemption" ADD CONSTRAINT "NewUserVoucherRedemption_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "Promo"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewUserVoucherRedemption" ADD CONSTRAINT "NewUserVoucherRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- 3. Global quota guards. Both writes that can break them (checkout increment,
--    admin maxUsageCount edit) lock the same Promo row, so the check is evaluated
--    on the serialized result and a concurrent edit cannot slip past it.
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_currentUsageCount_nonneg" CHECK ("currentUsageCount" >= 0);
ALTER TABLE "Promo" ADD CONSTRAINT "Promo_currentUsageCount_within_max" CHECK ("maxUsageCount" IS NULL OR "currentUsageCount" <= "maxUsageCount");

-- 4. Deterministic historical backfill of New User redemptions.
--    A New User promo is classified by its CURRENT Promo."isNewUserOnly".
--    Payment evidence (PaymentStatus enum: PENDING, WAITING_VERIFICATION, PAID,
--    FAILED, EXPIRED, REFUNDED - verified against schema and database):
--      consumed  : payment PAID or REFUNDED, or verifiedAt set (any order status)
--      active    : order not CANCELLED and not soft-deleted, and no payment row
--                  or payment PENDING / WAITING_VERIFICATION
--      released  : everything else (FAILED, EXPIRED, unpaid cancelled/deleted) -
--                  not backfilled
--    Several qualifying rows for one user: keep ONE - paid evidence first, then
--    the earliest (verifiedAt, then usage createdAt, then usage id). The other
--    VoucherUsage rows stay as history; nothing is deleted.
INSERT INTO "NewUserVoucherRedemption" ("id", "userId", "promoId", "orderId", "createdAt")
SELECT DISTINCT ON (u."userId")
       gen_random_uuid()::text, u."userId", u."voucherId", u."orderId", u."createdAt"
FROM "VoucherUsage" u
JOIN "Promo" p ON p."id" = u."voucherId" AND p."isNewUserOnly" = true
JOIN "Order" o ON o."id" = u."orderId"
LEFT JOIN "Payment" pay ON pay."orderId" = o."id"
WHERE (pay."status" IN ('PAID', 'REFUNDED') OR pay."verifiedAt" IS NOT NULL)
   OR (o."status" <> 'CANCELLED'
       AND o."deletedAt" IS NULL
       AND (pay."id" IS NULL OR pay."status" IN ('PENDING', 'WAITING_VERIFICATION')))
ORDER BY u."userId",
         (pay."status" IN ('PAID', 'REFUNDED') OR pay."verifiedAt" IS NOT NULL) DESC NULLS LAST,
         COALESCE(pay."verifiedAt", u."createdAt") ASC,
         u."createdAt" ASC,
         u."id" ASC;
