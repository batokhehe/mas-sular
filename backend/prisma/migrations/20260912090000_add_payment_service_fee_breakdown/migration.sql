-- Payment service fee breakdown (PAYMENT_SERVICE_FEE_ENABLED).
--
-- The applicable Midtrans fee is now recorded in BOTH modes, split into what the
-- customer is charged and what the merchant absorbs, per order (current attempt)
-- and per payment attempt (the authoritative, historical snapshot).
--
-- Additive and non-destructive: every new amount defaults to 0 and every snapshot
-- column is nullable, so existing rows keep their meaning. Legacy orders carried
-- a customer-borne fee in "paymentServiceFee"; that column keeps that meaning
-- (customer-charged), and the backfill below records it as the calculated fee with
-- nothing absorbed, so the invariant holds for historical rows too.

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "paymentServiceFeeCalculated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paymentServiceFeeAbsorbed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paymentServiceFeeEnabled" BOOLEAN,
  ADD COLUMN "paymentServiceFeeChannel" VARCHAR(32),
  ADD COLUMN "paymentServiceFeeRule" JSONB;

UPDATE "Order" SET "paymentServiceFeeCalculated" = "paymentServiceFee" WHERE "paymentServiceFee" > 0;

-- AlterTable
ALTER TABLE "PaymentGatewayTransaction"
  ADD COLUMN "baseAmount" INTEGER,
  ADD COLUMN "serviceFeeCalculated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceFeeCustomer" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceFeeAbsorbed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceFeeEnabled" BOOLEAN,
  ADD COLUMN "serviceFeeRule" JSONB;

-- Auditability invariants, enforced by the database (Prisma does not model CHECKs).
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_paymentServiceFee_breakdown_check" CHECK (
    "paymentServiceFee" >= 0 AND "paymentServiceFeeAbsorbed" >= 0
    AND "paymentServiceFeeCalculated" = "paymentServiceFee" + "paymentServiceFeeAbsorbed"
  );

ALTER TABLE "PaymentGatewayTransaction"
  ADD CONSTRAINT "PaymentGatewayTransaction_serviceFee_breakdown_check" CHECK (
    "serviceFeeCustomer" >= 0 AND "serviceFeeAbsorbed" >= 0
    AND "serviceFeeCalculated" = "serviceFeeCustomer" + "serviceFeeAbsorbed"
    AND ("baseAmount" IS NULL OR "grossAmount" = "baseAmount" + "serviceFeeCustomer")
  );
