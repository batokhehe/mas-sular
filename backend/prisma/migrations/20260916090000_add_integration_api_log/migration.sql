-- Integration API logging (P1): one durable record per ACTUAL external HTTP
-- exchange with Paxel, JNE and Midtrans — one per retry attempt outbound, one per
-- received webhook inbound, plus an application-outcome record where the provider
-- response still has to be interpreted (JNE answering 200 with no cnote).
--
-- Additive and non-destructive: three new enum types and one new table. No existing
-- table, column, index or row is touched, so `migrate deploy` is safe to run against
-- a live database and nothing needs backfilling.
--
-- Deliberately a separate table rather than SystemLog: the Performance Profiler
-- aggregates every SystemLog row with a non-null "durationMs" and no module filter,
-- so provider-call latencies would corrupt the request percentiles it reports.

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('PAXEL', 'JNE', 'MIDTRANS');

-- CreateEnum
CREATE TYPE "IntegrationDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "IntegrationOutcome" AS ENUM ('OK', 'HTTP_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'PARSE_FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "IntegrationApiLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" "IntegrationProvider" NOT NULL,
    "operation" VARCHAR(48) NOT NULL,
    "direction" "IntegrationDirection" NOT NULL,
    "operationId" VARCHAR(36) NOT NULL,
    "attempt" INTEGER,
    "maxAttempts" INTEGER,
    "requestId" VARCHAR(64),
    "correlationId" VARCHAR(128),
    "orderId" VARCHAR(36),
    "paymentId" VARCHAR(36),
    "shipmentId" VARCHAR(36),
    "method" VARCHAR(8),
    "endpoint" VARCHAR(512),
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "applicationOutcome" "IntegrationOutcome" NOT NULL,
    "errorClass" VARCHAR(32),
    "errorMessage" VARCHAR(512),
    "sanitizedRequest" JSONB,
    "sanitizedResponse" JSONB,

    CONSTRAINT "IntegrationApiLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationApiLog_createdAt_idx" ON "IntegrationApiLog"("createdAt");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_provider_createdAt_idx" ON "IntegrationApiLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_operation_createdAt_idx" ON "IntegrationApiLog"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_applicationOutcome_createdAt_idx" ON "IntegrationApiLog"("applicationOutcome", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_httpStatus_createdAt_idx" ON "IntegrationApiLog"("httpStatus", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_operationId_idx" ON "IntegrationApiLog"("operationId");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_orderId_idx" ON "IntegrationApiLog"("orderId");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_paymentId_idx" ON "IntegrationApiLog"("paymentId");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_shipmentId_idx" ON "IntegrationApiLog"("shipmentId");

-- CreateIndex
CREATE INDEX "IntegrationApiLog_requestId_idx" ON "IntegrationApiLog"("requestId");

