-- P2 #14: capability token for the customer-facing invoice page. Only the SHA-256
-- hash of the URL secret is stored (same pattern as "PaymentUploadToken").

-- CreateTable
CREATE TABLE "OrderInvoiceToken" (
    "id" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "orderId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" VARCHAR(36),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderInvoiceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderInvoiceToken_tokenHash_key" ON "OrderInvoiceToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OrderInvoiceToken_orderId_idx" ON "OrderInvoiceToken"("orderId");

-- CreateIndex
CREATE INDEX "OrderInvoiceToken_expiresAt_idx" ON "OrderInvoiceToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "OrderInvoiceToken" ADD CONSTRAINT "OrderInvoiceToken_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
