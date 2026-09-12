-- P2 #10: product-level "Promo Special" flag for the homepage product section.
-- NOT NULL DEFAULT false: every existing product stays out of the section until an
-- admin (or the local dev seed) turns it on.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "isPromoSpecial" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Product_isPromoSpecial_idx" ON "Product"("isPromoSpecial");
