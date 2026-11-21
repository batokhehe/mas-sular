-- Booking-attempt ownership token (duplicate courier booking recovery).
-- Additive and backward compatible: two nullable columns, no default, no backfill,
-- no index (only ever read and compared by primary key). In PostgreSQL this is a
-- catalog-only change; the table is not rewritten. Existing rows keep NULL, which
-- the application treats exactly as before (legacy lease reclaim).
ALTER TABLE "Shipment" ADD COLUMN "bookingAttemptId" VARCHAR(36);
ALTER TABLE "Shipment" ADD COLUMN "bookingAttemptStartedAt" TIMESTAMP(3);
