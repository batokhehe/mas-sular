-- Canonical product ordering (Product.sequence).
--
-- Additive: one new column with a default, one data backfill, one index. No existing
-- column is altered and nothing is dropped, so `migrate deploy` is safe against a live
-- database. The UPDATE is idempotent in effect (re-running it recomputes the same
-- values from the same inputs) and touches only this new column.
--
-- Backfill order IS the storefront's previous default ordering
-- (reviewCount DESC, then createdAt DESC, then id ASC as a total-order tiebreak), so
-- switching every product list to `sequence ASC` does not reorder the storefront on
-- deploy. Soft-deleted products are numbered too: they keep a stable position should
-- they ever be restored, and they are simply never listed while deletedAt is set.
-- Values are contiguous 1..N here; later reorders keep them contiguous, while a
-- soft delete leaves a gap on purpose (no renumbering).

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;

-- Backfill (data)
WITH ordered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "reviewCount" DESC, "createdAt" DESC, "id" ASC) AS rn
    FROM "Product"
)
UPDATE "Product" p
SET "sequence" = ordered.rn
FROM ordered
WHERE ordered."id" = p."id";

-- CreateIndex
CREATE INDEX "Product_sequence_idx" ON "Product"("sequence");
