-- Immutable address snapshots (Print Resi hardening).
--
-- ADDITIVE ONLY: two nullable JSONB columns. No default, no backfill, no rewrite of
-- existing rows - orders and shipments created before this migration keep NULL and
-- the application falls back to the live Order.address relation for them.
--
--   Order.recipientSnapshot      - the recipient as validated at checkout, written in
--                                  the order-create transaction, never updated.
--   Shipment.destinationSnapshot - the receiver fields actually submitted to the
--                                  courier, written with the AWB of a successful booking.
--
-- Adding a nullable column without a default is a catalog-only change in PostgreSQL
-- (no table rewrite, brief ACCESS EXCLUSIVE lock only).
--
-- Rollback: the application tolerates NULL in both columns, so rolling the APP back
-- needs no schema change and the columns can simply stay. Removing them would delete
-- the only historical record of these addresses; that is deliberately NOT scripted
-- here and needs explicit approval plus a backup first.

ALTER TABLE "Order" ADD COLUMN "recipientSnapshot" JSONB;

ALTER TABLE "Shipment" ADD COLUMN "destinationSnapshot" JSONB;
