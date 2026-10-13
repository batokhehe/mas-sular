-- P2 #11: product-level "Trial Pack" flag for the homepage product section.
-- NOT NULL DEFAULT false: every existing product stays out of the section until an
-- admin (or the local dev seed) turns it on.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "isTrialPack" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Product_isTrialPack_idx" ON "Product"("isTrialPack");
