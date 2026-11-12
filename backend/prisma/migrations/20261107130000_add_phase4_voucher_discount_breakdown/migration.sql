-- Phase 4: voucher discount breakdown persistence/display components.
--
-- Additive only. Preserves all historical orders and does not backfill
-- historical breakdown values. voucherDiscountAmount is not altered.
-- No payment/shipping/checkout calculation behavior changes. No data deletion.

-- CreateEnum
CREATE TYPE "ProductDiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "ShippingDiscountType" AS ENUM ('PERCENTAGE', 'FIXED', 'FREE_SHIPPING');

-- AlterTable: Promo (independent product/shipping discount component config)
ALTER TABLE "Promo" ADD COLUMN     "eligibleCouriers" JSONB,
ADD COLUMN     "productDiscountType" "ProductDiscountType",
ADD COLUMN     "productDiscountPercentage" INTEGER,
ADD COLUMN     "productDiscountAmount" INTEGER,
ADD COLUMN     "productMaxDiscountAmount" INTEGER,
ADD COLUMN     "shippingDiscountType" "ShippingDiscountType",
ADD COLUMN     "shippingDiscountPercentage" INTEGER,
ADD COLUMN     "shippingDiscountAmount" INTEGER,
ADD COLUMN     "shippingMaxDiscountAmount" INTEGER;

-- AlterTable: Order (persisted breakdown for new orders; legacy rows keep defaults)
ALTER TABLE "Order" ADD COLUMN     "productDiscountAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shippingDiscountAmount" INTEGER NOT NULL DEFAULT 0;
