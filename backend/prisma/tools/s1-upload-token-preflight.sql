-- S1 phase 2 — READ-ONLY preflight for historical payment-upload token exposure.
--
-- Counts only. It never selects a payload, token, hash or URL value, so its
-- output is safe to paste into a ticket. Run it in a READ ONLY transaction with
-- a statement timeout, against the database you are assessing:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/tools/s1-upload-token-preflight.sql
--
-- It writes nothing (the transaction is READ ONLY and rolled back).

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. OutboxEvent rows still carrying the upload link (pre-S1 order.created /
--    payment.reminder), by event, status and age bucket.
SELECT "eventName",
       status,
       CASE WHEN "createdAt" >= now() - interval '72 hours' THEN 'lt_72h' ELSE 'ge_72h' END AS age,
       count(*) AS rows
FROM "OutboxEvent"
WHERE payload ? 'uploadUrl' OR payload ? 'uploadToken'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. NotificationOutbox rows still carrying the token / link, by template, status, age.
SELECT template,
       status,
       CASE WHEN "createdAt" >= now() - interval '72 hours' THEN 'lt_72h' ELSE 'ge_72h' END AS age,
       count(*) FILTER (WHERE payload ? 'uploadToken') AS with_upload_token,
       count(*) FILTER (WHERE payload ? 'uploadUrl')   AS with_upload_url
FROM "NotificationOutbox"
WHERE payload ? 'uploadToken' OR payload ? 'uploadUrl'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 3. Upload tokens that are still USABLE (unused, unexpired). These are the only
--    ones a leaked historical value could still open. Hash rows only — the
--    secret itself is not in this table.
SELECT count(*) AS active_tokens,
       min("expiresAt") AS earliest_expiry,
       max("expiresAt") AS latest_expiry
FROM "PaymentUploadToken"
WHERE "usedAt" IS NULL AND "expiresAt" > now();

-- 4. Of those, how many belong to payments that can still accept a receipt
--    (the only state in which a leaked link has any effect).
SELECT p.status, count(*) AS active_tokens
FROM "PaymentUploadToken" t
JOIN "Payment" p ON p.id = t."paymentId"
WHERE t."usedAt" IS NULL AND t."expiresAt" > now()
GROUP BY 1
ORDER BY 1;

ROLLBACK;
