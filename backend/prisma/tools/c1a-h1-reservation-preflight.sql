-- C1-a — READ-ONLY preflight for historical inventory-reservation inconsistencies (H1).
--
-- Before C1-a, the reservation worker could EXPIRE a reservation while its payment
-- was still payable, and a later settlement then marked the payment PAID while
-- commitForOrder silently skipped the EXPIRED row (no stock deducted). C1-a stops
-- new cases (payment-first expiry lock + settlement coverage guard). This script
-- measures the cases that already exist in a database, so an operator can decide
-- what to do with them BEFORE deploying C1-a.
--
-- It reports, it never repairs: no reservation is released, committed or expired,
-- no stock is deducted or restored, no payment or order changes.
--
-- Run it with psql (the \echo lines are psql meta-commands), with credentials that
-- can SELECT only, against the database you are assessing:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/tools/c1a-h1-reservation-preflight.sql
--
-- Write safety:
--   * one transaction, READ ONLY (PostgreSQL rejects any INSERT/UPDATE/DELETE/DDL
--     inside it) and REPEATABLE READ (every section sees the same snapshot);
--   * statement_timeout bounds each query; lock_timeout stops it from queueing
--     behind a migration's exclusive lock; it only takes ACCESS SHARE locks;
--   * it ends with ROLLBACK, and on any error ON_ERROR_STOP aborts the run.
--
-- Output: identifiers only (order number, order / payment / product / outlet ids,
-- product name and SKU) plus counts and quantities. No customer name, email, phone,
-- address, payment proof or gateway payload is selected, so the output can be
-- attached to an internal ticket.
--
-- Coverage model — the same rule the C1-a settlement guard applies
-- (InventoryReservationService.assertCommittedCoverage):
--   required(order, product)  = Σ OrderItem.quantity   (items for the same product summed)
--   committed(order, product) = Σ committedQty of COMMITTED reservation rows
--   held(order, product)      = Σ reservedQty  of RESERVED  reservation rows
--   An order with NO reservation rows is a legacy order (stock was handled before
--   reservations existed) and is NOT assessed — it is only counted in section 0.
--   All reservation rows of an order are considered, whatever their status, and a
--   product present only on one side (items without reservations, or reservations
--   without items) is a mismatch too.
--
-- Stock model, per reservation row: "outlet" when a ProductInventory row exists for
-- (productId, outletId) — commit deducts ProductInventory.stock; otherwise "legacy"
-- — commit deducts Product.stock. "mixed" = an order/product with rows of both kinds.

\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 0. Scope and data-shape checks
-- ============================================================================

\echo '== 0.1 Orders by payment status: assessed (has reservations) vs legacy (none)'
-- How much of the database this preflight can say anything about. Legacy orders
-- (no reservation rows) are outside C1-a's guard and are not assessed below.
SELECT coalesce(p.status::text, 'NO_PAYMENT')                     AS payment_status,
       count(*)                                                  AS orders,
       count(*) FILTER (WHERE has_res)                           AS with_reservations,
       count(*) FILTER (WHERE NOT has_res)                       AS legacy_no_reservations,
       count(*) FILTER (WHERE o."deletedAt" IS NOT NULL)         AS order_soft_deleted,
       count(*) FILTER (WHERE p."deletedAt" IS NOT NULL)         AS payment_soft_deleted
FROM "Order" o
LEFT JOIN "Payment" p ON p."orderId" = o.id
CROSS JOIN LATERAL (
  SELECT EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = o.id) AS has_res
) x
GROUP BY 1
ORDER BY 1;

\echo '== 0.2 Reservation data-shape anomalies (expected: all zero)'
-- duplicate_order_product_rows : checkout writes ONE row per (order, product); more
--                                rows are tolerated (quantities are summed) but unusual.
-- committed_rows_unpaid_payment: a COMMITTED row whose payment is not PAID/REFUNDED.
-- rows_without_payment         : reservations of an order that has no Payment row.
-- rows_soft_deleted_payment    : reservations whose Payment row is soft-deleted.
SELECT 'duplicate_order_product_rows' AS check_name, count(*) AS rows
FROM (SELECT 1 FROM "InventoryReservation" GROUP BY "orderId", "productId" HAVING count(*) > 1) d
UNION ALL
SELECT 'committed_rows_unpaid_payment', count(*)
FROM "InventoryReservation" r
JOIN "Payment" p ON p."orderId" = r."orderId"
WHERE r.status = 'COMMITTED' AND p.status NOT IN ('PAID', 'REFUNDED')
UNION ALL
SELECT 'rows_without_payment', count(*)
FROM "InventoryReservation" r
WHERE NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = r."orderId")
UNION ALL
SELECT 'rows_soft_deleted_payment', count(*)
FROM "InventoryReservation" r
JOIN "Payment" p ON p."orderId" = r."orderId"
WHERE p."deletedAt" IS NOT NULL;

-- ============================================================================
-- A. PAYABLE payments whose stock is no longer (fully) held
--    Payment PENDING / WAITING_VERIFICATION, not soft-deleted, order has
--    reservation rows, and what settle() WOULD commit (COMMITTED + RESERVED)
--    does not equal what was ordered for at least one product.
--
--    After C1-a, settling one of these fails closed with InventoryCoverageError:
--    an admin verify answers 409; a gateway settlement records a
--    payment.settlement_inventory_conflict incident and the payment stays PENDING
--    until the lifecycle worker expires it. Before C1-a, the same settlement
--    would have produced PAID without (full) stock deduction (H1).
-- ============================================================================

\echo '== A.1 Payable payments with broken coverage — summary'
-- order_state  : order_active (would hit the guard) | order_cancelled (settle is
--                already refused for a cancelled order; audit M2) | order_soft_deleted
-- cause        : expired_rows | released_rows (a reservation in that state) |
--                excess (more held+committed than ordered) | missing_or_partial
-- age          : since Payment.createdAt; with the lifecycle worker on, payments
--                older than their window (24 h default) are about to be expired anyway
-- reconciliation_candidates : GATEWAY payments with a non-terminal Midtrans ledger
--                row — reconciliation will retry them, each retry is an incident bump
WITH scope AS (
  SELECT p.id AS payment_id, p."orderId" AS order_id, p.status AS payment_status, p.method,
         p."createdAt" AS payment_created_at, o.status AS order_status, o."deletedAt" AS order_deleted_at
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p.status IN ('PENDING', 'WAITING_VERIFICATION')
    AND p."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."reservedQty")  FILTER (WHERE r.status = 'RESERVED'),  0)::bigint AS held_qty,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         count(*) FILTER (WHERE r.status = 'EXPIRED')  AS expired_rows,
         count(*) FILTER (WHERE r.status = 'RELEASED') AS released_rows
  FROM "InventoryReservation" r
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
cov AS (
  SELECT coalesce(req.order_id, res.order_id)     AS order_id,
         coalesce(req.required_qty, 0)            AS required_qty,
         coalesce(res.held_qty, 0) + coalesce(res.committed_qty, 0) AS would_commit_qty,
         coalesce(res.expired_rows, 0)            AS expired_rows,
         coalesce(res.released_rows, 0)           AS released_rows
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
),
per_order AS (
  SELECT order_id,
         sum(greatest(required_qty - would_commit_qty, 0)) AS short_units,
         sum(greatest(would_commit_qty - required_qty, 0)) AS excess_units,
         -- cause is taken from the MISMATCHED products only, so a covered product's
         -- stale EXPIRED/RELEASED duplicate row cannot mislabel another product's gap
         coalesce(sum(expired_rows)  FILTER (WHERE required_qty <> would_commit_qty), 0) AS expired_rows,
         coalesce(sum(released_rows) FILTER (WHERE required_qty <> would_commit_qty), 0) AS released_rows
  FROM cov
  GROUP BY order_id
  HAVING bool_or(required_qty <> would_commit_qty)
)
SELECT s.method,
       s.payment_status,
       CASE WHEN s.order_deleted_at IS NOT NULL THEN 'order_soft_deleted'
            WHEN s.order_status = 'CANCELLED'   THEN 'order_cancelled'
            ELSE 'order_active' END                                       AS order_state,
       CASE WHEN po.expired_rows  > 0 THEN 'expired_rows'
            WHEN po.released_rows > 0 THEN 'released_rows'
            WHEN po.excess_units  > 0 THEN 'excess'
            ELSE 'missing_or_partial' END                                 AS cause,
       CASE WHEN s.payment_created_at >= now() - interval '24 hours' THEN 'lt_24h'
            WHEN s.payment_created_at >= now() - interval '72 hours' THEN '24h_72h'
            ELSE 'ge_72h' END                                             AS age,
       count(*)                                                           AS orders,
       sum(po.short_units)                                                AS short_units,
       sum(po.excess_units)                                               AS excess_units,
       count(*) FILTER (
         WHERE s.method = 'GATEWAY' AND EXISTS (
           SELECT 1 FROM "PaymentGatewayTransaction" g
           WHERE g."paymentId" = s.payment_id AND g.provider = 'midtrans'
             AND g."providerOrderId" IS NOT NULL   -- as MidtransReconciliationWorker.findCandidates
             AND g.status NOT IN ('SETTLEMENT', 'CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED')))
                                                                          AS reconciliation_candidates
FROM per_order po
JOIN scope s ON s.order_id = po.order_id
GROUP BY 1, 2, 3, 4, 5
ORDER BY 3, 1, 2, 4, 5;

\echo '== A.2 Payable payments with broken coverage — detail (oldest first, max 500)'
-- One row per affected order, for investigation. stock_model: legacy | outlet | mixed.
WITH scope AS (
  SELECT p.id AS payment_id, p."orderId" AS order_id, p.status AS payment_status, p.method,
         p."createdAt" AS payment_created_at, o."orderNumber" AS order_number,
         o.status AS order_status, o."deletedAt" AS order_deleted_at
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p.status IN ('PENDING', 'WAITING_VERIFICATION')
    AND p."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."reservedQty")  FILTER (WHERE r.status = 'RESERVED'),  0)::bigint AS held_qty,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         count(*) FILTER (WHERE r.status = 'EXPIRED')  AS expired_rows,
         count(*) FILTER (WHERE r.status = 'RELEASED') AS released_rows,
         bool_or(pi.id IS NOT NULL) AS any_outlet,
         bool_or(pi.id IS NULL)     AS any_legacy
  FROM "InventoryReservation" r
  LEFT JOIN "ProductInventory" pi ON pi."productId" = r."productId" AND pi."outletId" = r."outletId"
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
cov AS (
  SELECT coalesce(req.order_id, res.order_id) AS order_id,
         coalesce(req.required_qty, 0)        AS required_qty,
         coalesce(res.held_qty, 0) + coalesce(res.committed_qty, 0) AS would_commit_qty,
         coalesce(res.expired_rows, 0)        AS expired_rows,
         coalesce(res.released_rows, 0)       AS released_rows,
         coalesce(res.any_outlet, false)      AS any_outlet,
         coalesce(res.any_legacy, false)      AS any_legacy
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
),
per_order AS (
  SELECT order_id,
         count(*) FILTER (WHERE required_qty <> would_commit_qty) AS mismatched_products,
         sum(greatest(required_qty - would_commit_qty, 0))       AS short_units,
         sum(greatest(would_commit_qty - required_qty, 0))       AS excess_units,
         sum(expired_rows)  AS expired_rows,
         sum(released_rows) AS released_rows,
         CASE WHEN bool_or(any_outlet) AND bool_or(any_legacy) THEN 'mixed'
              WHEN bool_or(any_outlet) THEN 'outlet' ELSE 'legacy' END AS stock_model
  FROM cov
  GROUP BY order_id
  HAVING bool_or(required_qty <> would_commit_qty)
)
SELECT s.order_number, s.order_id, s.payment_id, s.method, s.payment_status, s.order_status,
       (s.order_deleted_at IS NOT NULL) AS order_soft_deleted,
       s.payment_created_at, po.stock_model, po.mismatched_products,
       po.short_units, po.excess_units, po.expired_rows, po.released_rows
FROM per_order po
JOIN scope s ON s.order_id = po.order_id
ORDER BY s.payment_created_at, s.order_number
LIMIT 500;

-- ============================================================================
-- B. PAID payments whose stock ledger does not match the order (historical H1)
--    Payment PAID, not soft-deleted, order has reservation rows.
--
--    Order ACTIVE (not cancelled; soft-deleted orders are listed but labelled):
--      expected Σ committed (COMMITTED rows) = Σ ordered, per product.
--      short  = sold but never deducted (H1)  -> ledger stock too HIGH
--      excess = deducted more than once        -> ledger stock too LOW
--
--    Order CANCELLED: cancellation releases COMMITTED rows to RELEASED and restocks
--      them; releaseForOrder keeps committedQty on the RELEASED row. So the
--      expected end state is: no row still COMMITTED, and Σ committedQty of the
--      RELEASED rows = Σ ordered. A normal paid cancellation is therefore NOT
--      reported. Reported:
--        cancelled_not_restocked  : a row is still COMMITTED -> deducted and never
--                                   restored; excess_units = those units (stock LOW)
--        cancelled_never_committed: nothing was ever committed (H1, then cancelled);
--                                   net stock effect zero — informational
--        cancelled_partial        : some ordered units were never committed;
--                                   net stock effect zero — informational
-- ============================================================================

\echo '== B.1 PAID payments with ledger mismatch — summary'
-- row_states  : non-committed reservation states the order still has
--               (RELEASED+ = released after having been committed)
-- stock_model : legacy | outlet | mixed
-- age         : since Payment.verifiedAt (falls back to Payment.createdAt)
WITH scope AS (
  SELECT p.id AS payment_id, p."orderId" AS order_id, p.method,
         coalesce(p."verifiedAt", p."createdAt") AS paid_at,
         o.status AS order_status, o."deletedAt" AS order_deleted_at,
         (o.status = 'CANCELLED') AS cancelled
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p.status = 'PAID'
    AND p."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'RELEASED'),  0)::bigint AS released_committed_qty,
         count(*) FILTER (WHERE r.status = 'EXPIRED')   AS expired_rows,
         count(*) FILTER (WHERE r.status = 'RELEASED' AND r."committedQty" = 0) AS released_rows,
         count(*) FILTER (WHERE r.status = 'RELEASED' AND r."committedQty" > 0) AS released_after_commit_rows,
         count(*) FILTER (WHERE r.status = 'RESERVED')  AS reserved_rows,
         count(*) FILTER (WHERE r.status = 'CANCELLED') AS cancelled_rows,
         bool_or(pi.id IS NOT NULL) AS any_outlet,
         bool_or(pi.id IS NULL)     AS any_legacy
  FROM "InventoryReservation" r
  LEFT JOIN "ProductInventory" pi ON pi."productId" = r."productId" AND pi."outletId" = r."outletId"
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
cov AS (
  SELECT coalesce(req.order_id, res.order_id)   AS order_id,
         coalesce(req.required_qty, 0)          AS required_qty,
         coalesce(res.committed_qty, 0)         AS committed_qty,
         coalesce(res.released_committed_qty, 0) AS released_committed_qty,
         coalesce(res.expired_rows, 0)          AS expired_rows,
         coalesce(res.released_rows, 0)         AS released_rows,
         coalesce(res.released_after_commit_rows, 0) AS released_after_commit_rows,
         coalesce(res.reserved_rows, 0)         AS reserved_rows,
         coalesce(res.cancelled_rows, 0)        AS cancelled_rows,
         coalesce(res.any_outlet, false)        AS any_outlet,
         coalesce(res.any_legacy, false)        AS any_legacy
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
),
per_order AS (
  SELECT order_id,
         bool_or(required_qty <> committed_qty)                          AS active_mismatch,
         bool_or(required_qty <> committed_qty + released_committed_qty) AS ever_mismatch,
         sum(committed_qty)                                              AS committed_total,
         sum(released_committed_qty)                                     AS released_committed_total,
         sum(greatest(required_qty - committed_qty, 0))                  AS short_units,
         sum(greatest(committed_qty - required_qty, 0))                  AS excess_units,
         concat_ws(',',
           CASE WHEN sum(expired_rows)   > 0 THEN 'EXPIRED'   END,
           CASE WHEN sum(released_rows)  > 0 THEN 'RELEASED'  END,
           CASE WHEN sum(released_after_commit_rows) > 0 THEN 'RELEASED+' END,
           CASE WHEN sum(reserved_rows)  > 0 THEN 'RESERVED'  END,
           CASE WHEN sum(cancelled_rows) > 0 THEN 'CANCELLED' END) AS row_states,
         CASE WHEN bool_or(any_outlet) AND bool_or(any_legacy) THEN 'mixed'
              WHEN bool_or(any_outlet) THEN 'outlet' ELSE 'legacy' END AS stock_model
  FROM cov
  GROUP BY order_id
),
flagged AS (
  SELECT s.*, po.committed_total, po.short_units, po.excess_units, po.row_states, po.stock_model,
         CASE WHEN s.cancelled AND po.committed_total > 0       THEN 'cancelled_not_restocked'
              WHEN s.cancelled AND po.released_committed_total = 0 THEN 'cancelled_never_committed'
              WHEN s.cancelled                                   THEN 'cancelled_partial'
              WHEN po.committed_total = 0                        THEN 'never_committed'
              WHEN po.short_units > 0 AND po.excess_units > 0    THEN 'short_and_excess'
              WHEN po.excess_units > 0                           THEN 'excess'
              ELSE 'partial' END AS cause
  FROM per_order po
  JOIN scope s ON s.order_id = po.order_id
  WHERE CASE WHEN s.cancelled THEN po.committed_total > 0 OR po.ever_mismatch
             ELSE po.active_mismatch END
)
SELECT CASE WHEN order_deleted_at IS NOT NULL THEN 'order_soft_deleted'
            WHEN cancelled                    THEN 'order_cancelled'
            ELSE 'order_active' END                                       AS order_state,
       order_status,
       cause,
       nullif(row_states, '')                                             AS row_states,
       stock_model,
       CASE WHEN paid_at >= now() - interval '7 days'  THEN 'lt_7d'
            WHEN paid_at >= now() - interval '30 days' THEN '7d_30d'
            ELSE 'ge_30d' END                                             AS age,
       count(*)                                                           AS orders,
       sum(CASE WHEN cancelled THEN 0 ELSE short_units END)               AS short_units,
       sum(CASE WHEN cancelled THEN committed_total ELSE excess_units END) AS excess_units
FROM flagged
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 3, 2, 4, 5, 6;

\echo '== B.2 PAID, order active: unit discrepancy per deduction target (inventory reconciliation input)'
-- deduction_target : Product.stock (legacy rows) | ProductInventory (outlet rows) |
--                    ambiguous (rows of both models, or outlet rows at more than one
--                    outlet, for the same order and product) | no_reservation_row
-- outlet_id        : the ProductInventory outlet; only for an unambiguous outlet
--                    target. Legacy rows carry an outlet id too (checkout stamps the
--                    first active outlet) but their stock lives in Product.stock, so
--                    it is not shown as a target.
-- outlets          : every outlet id on the rows — resolve "ambiguous" groups from
--                    B.3 and the reservation history; never attribute them blindly.
-- short_units      : sold but never deducted (ledger stock too HIGH)
-- excess_units     : deducted more than once  (ledger stock too LOW)
WITH scope AS (
  SELECT p."orderId" AS order_id
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p.status = 'PAID'
    AND p."deletedAt" IS NULL
    AND o."deletedAt" IS NULL
    AND o.status <> 'CANCELLED'
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         count(DISTINCT r."outletId")                  AS outlet_count,
         string_agg(DISTINCT r."outletId", ',')        AS outlets,
         bool_and(pi.id IS NOT NULL)                   AS all_outlet,
         bool_or(pi.id IS NOT NULL)                    AS any_outlet
  FROM "InventoryReservation" r
  LEFT JOIN "ProductInventory" pi ON pi."productId" = r."productId" AND pi."outletId" = r."outletId"
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
cov AS (
  SELECT coalesce(req.product_id, res.product_id) AS product_id,
         CASE WHEN res.order_id IS NULL                         THEN 'no_reservation_row'
              WHEN NOT res.any_outlet                           THEN 'Product.stock'
              WHEN res.all_outlet AND res.outlet_count = 1      THEN 'ProductInventory'
              ELSE 'ambiguous' END                             AS deduction_target,
         CASE WHEN res.all_outlet AND res.outlet_count = 1 THEN res.outlets END AS outlet_id,
         res.outlets,
         coalesce(req.required_qty, 0)  AS required_qty,
         coalesce(res.committed_qty, 0) AS committed_qty
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
)
SELECT c.product_id, pr.sku, pr.name AS product_name, c.deduction_target, c.outlet_id,
       CASE WHEN c.deduction_target = 'ambiguous' THEN c.outlets END AS outlets,
       count(*)                                           AS orders,
       sum(greatest(c.required_qty - c.committed_qty, 0)) AS short_units,
       sum(greatest(c.committed_qty - c.required_qty, 0)) AS excess_units
FROM cov c
LEFT JOIN "Product" pr ON pr.id = c.product_id
WHERE c.required_qty <> c.committed_qty
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY short_units DESC, excess_units DESC, 3, 4;

\echo '== B.3 PAID payments with ledger mismatch — detail (active first, oldest first, max 500)'
WITH scope AS (
  SELECT p.id AS payment_id, p."orderId" AS order_id, p.method,
         coalesce(p."verifiedAt", p."createdAt") AS paid_at,
         o."orderNumber" AS order_number, o.status AS order_status, o."deletedAt" AS order_deleted_at,
         (o.status = 'CANCELLED') AS cancelled
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p.status = 'PAID'
    AND p."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'RELEASED'),  0)::bigint AS released_committed_qty,
         count(*) FILTER (WHERE r.status = 'EXPIRED')  AS expired_rows,
         count(*) FILTER (WHERE r.status = 'RELEASED') AS released_rows,
         count(*) FILTER (WHERE r.status = 'RESERVED') AS reserved_rows,
         string_agg(DISTINCT r."outletId", ',')        AS outlets
  FROM "InventoryReservation" r
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
cov AS (
  SELECT coalesce(req.order_id, res.order_id)    AS order_id,
         coalesce(req.required_qty, 0)           AS required_qty,
         coalesce(res.committed_qty, 0)          AS committed_qty,
         coalesce(res.released_committed_qty, 0) AS released_committed_qty,
         coalesce(res.expired_rows, 0)           AS expired_rows,
         coalesce(res.released_rows, 0)          AS released_rows,
         coalesce(res.reserved_rows, 0)          AS reserved_rows,
         res.outlets
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
),
per_order AS (
  SELECT order_id,
         bool_or(required_qty <> committed_qty)                          AS active_mismatch,
         bool_or(required_qty <> committed_qty + released_committed_qty) AS ever_mismatch,
         count(*) FILTER (WHERE required_qty <> committed_qty)           AS mismatched_products,
         sum(committed_qty)                                              AS committed_total,
         sum(greatest(required_qty - committed_qty, 0))                  AS short_units,
         sum(greatest(committed_qty - required_qty, 0))                  AS excess_units,
         sum(expired_rows) AS expired_rows, sum(released_rows) AS released_rows, sum(reserved_rows) AS reserved_rows,
         string_agg(DISTINCT outlets, ',')                               AS outlets
  FROM cov
  GROUP BY order_id
)
SELECT s.order_number, s.order_id, s.payment_id, s.method, s.order_status,
       (s.order_deleted_at IS NOT NULL) AS order_soft_deleted,
       s.paid_at, po.mismatched_products,
       CASE WHEN s.cancelled THEN 0 ELSE po.short_units END               AS short_units,
       CASE WHEN s.cancelled THEN po.committed_total ELSE po.excess_units END AS excess_units,
       po.expired_rows, po.released_rows, po.reserved_rows, po.outlets
FROM per_order po
JOIN scope s ON s.order_id = po.order_id
WHERE CASE WHEN s.cancelled THEN po.committed_total > 0 OR po.ever_mismatch ELSE po.active_mismatch END
ORDER BY (s.cancelled OR s.order_deleted_at IS NOT NULL), s.paid_at, s.order_number
LIMIT 500;

-- ============================================================================
-- C. Other paid evidence (informational)
--    REFUNDED payments, or a verifiedAt on a payment that is not PAID, with the
--    same expectation as B (active: Σ COMMITTED = Σ ordered; cancelled: nothing
--    still COMMITTED and Σ released-after-commit = Σ ordered). Refund handling is
--    outside C1-a; the current application never writes REFUNDED and only sets
--    verifiedAt together with PAID, so this is normally empty.
-- ============================================================================

\echo '== C.1 Other paid evidence with ledger mismatch — counts'
WITH scope AS (
  SELECT p."orderId" AS order_id, p.status AS payment_status, (o.status = 'CANCELLED') AS cancelled
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p."deletedAt" IS NULL
    AND (p.status = 'REFUNDED' OR (p."verifiedAt" IS NOT NULL AND p.status <> 'PAID'))
    AND EXISTS (SELECT 1 FROM "InventoryReservation" r WHERE r."orderId" = p."orderId")
),
req AS (
  SELECT oi."orderId" AS order_id, oi."productId" AS product_id, sum(oi.quantity)::bigint AS required_qty
  FROM "OrderItem" oi
  WHERE oi."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
res AS (
  SELECT r."orderId" AS order_id, r."productId" AS product_id,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'COMMITTED'), 0)::bigint AS committed_qty,
         coalesce(sum(r."committedQty") FILTER (WHERE r.status = 'RELEASED'),  0)::bigint AS released_committed_qty
  FROM "InventoryReservation" r
  WHERE r."orderId" IN (SELECT order_id FROM scope)
  GROUP BY 1, 2
),
per_order AS (
  SELECT coalesce(req.order_id, res.order_id) AS order_id,
         bool_or(coalesce(req.required_qty, 0) <> coalesce(res.committed_qty, 0)) AS active_mismatch,
         bool_or(coalesce(req.required_qty, 0) <> coalesce(res.committed_qty, 0) + coalesce(res.released_committed_qty, 0)) AS ever_mismatch,
         sum(coalesce(res.committed_qty, 0)) AS committed_total
  FROM req
  FULL JOIN res ON res.order_id = req.order_id AND res.product_id = req.product_id
  GROUP BY 1
)
SELECT s.payment_status,
       CASE WHEN s.cancelled THEN 'order_cancelled' ELSE 'order_active' END AS order_state,
       count(*) AS orders
FROM per_order po
JOIN scope s ON s.order_id = po.order_id
WHERE CASE WHEN s.cancelled THEN po.committed_total > 0 OR po.ever_mismatch ELSE po.active_mismatch END
GROUP BY 1, 2
ORDER BY 1, 2;

ROLLBACK;
