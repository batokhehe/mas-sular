-- Reservation-level inventory hold ownership (Track 3.1).
--
-- Until now commit / release / expiry decided whether to move ProductInventory
-- counters by whether a ProductInventory row exists AT THAT MOMENT. A reservation
-- created before its product had a "Stok Produk" row (legacy, held nothing there)
-- but settled after the row was created therefore decremented a hold it never
-- placed (production: product 11699095, reserved -1). The lifecycle now follows an
-- explicit, per-reservation fact instead.

ALTER TABLE "InventoryReservation"
  ADD COLUMN "inventoryHoldApplied" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from historical EVIDENCE, never from the mere existence of a row today.
-- The previous reserveForOrder placed a ProductInventory hold exactly when
--   (a) the order had an allocated outlet (Order.outletId) equal to the
--       reservation's outlet, AND
--   (b) the (productId, outletId) ProductInventory row already existed when the
--       reservation was created.
-- (b) uses the EARLIEST evidence of the row's existence: its createdAt or its first
-- AuditLog entry, whichever is older (createdAt values were rewritten after the
-- 2026-11-04 adoption, while the audit trail kept the original times).
-- Validated read-only against production before this migration was written: every
-- ProductInventory.reserved equals the RESERVED quantity this rule marks, except
-- the one known drift, and the only reservation it marks false that settled after
-- its row existed is the one that caused that drift.
WITH pi AS (
  SELECT p.id, p."productId", p."outletId",
         LEAST(p."createdAt",
               COALESCE((SELECT MIN(a."createdAt") FROM "AuditLog" a WHERE a."entityId" = p.id), p."createdAt")) AS exists_since
  FROM "ProductInventory" p
)
UPDATE "InventoryReservation" r
SET "inventoryHoldApplied" = true
FROM "Order" o, pi
WHERE o.id = r."orderId"
  AND r."outletId" IS NOT NULL
  AND o."outletId" = r."outletId"
  AND pi."productId" = r."productId"
  AND pi."outletId" = r."outletId"
  AND pi.exists_since <= r."createdAt";
