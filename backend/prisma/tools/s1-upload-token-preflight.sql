-- S1 phase 2 — READ-ONLY preflight for historical payment-upload token exposure.
--
-- Before S1 (6cdc275) the RAW upload-link secret was persisted in plaintext in:
--   * OutboxEvent.payload.uploadUrl          (order.created, payment.reminder)
--   * NotificationOutbox.payload.uploadToken (WhatsApp order.transfer)
--   * NotificationOutbox.payload.uploadUrl   (EMAIL payment.reminder)
--   * NotificationOutbox.lastError           (provider error text could echo the
--     request; S1 now scrubs the bound token before persisting lastError)
-- PaymentUploadToken itself only ever stores sha256(raw) as lowercase hex.
--
-- SCOPE: this script reads the DATABASE only. It does not and cannot see copies
-- in RabbitMQ (main, retry and DLQ queues), stdout / container logs or backups;
-- those need their own operator review.
--
-- How the application decides a token works (payment-upload-token.service.ts,
-- payments.service.ts, payment-upload.guards.ts):
--   token active : a row exists for sha256(raw), usedAt IS NULL, expiresAt > now()
--   GET upload page and POST upload/:token/file : token active AND payment exists,
--                  is NOT soft-deleted and is PENDING or WAITING_VERIFICATION
--   POST upload/:token (submit receipt) : token active AND payment PENDING or
--                  WAITING_VERIFICATION — it does NOT check payment.deletedAt
-- There is no revocation column. Raw tokens are 64 lowercase hex characters
-- (randomBytes(32).toString('hex')).
--
-- token_state of a stored copy (exactly one per copy, evaluated in this order):
--   malformed         the stored value has no standalone 64-hex token
--   no_token_row      no PaymentUploadToken row for its hash
--   used              usedAt is set
--   expired           unused, but expiresAt <= now()
--   live_link         active; payment exists, not soft-deleted, PENDING or
--                     WAITING_VERIFICATION  -> opens the upload page and submits
--   live_submit_only  active; payment soft-deleted but PENDING or
--                     WAITING_VERIFICATION -> the page refuses it, but the submit
--                     endpoint still accepts it
--   active_unusable   active, but the payment is paid / terminal (or missing)
-- A copy counted as a "usable stored copy" is live_link or live_submit_only.
--
-- Counts and timestamps only: it never selects a payload, token, hash, URL,
-- error text or customer data, so its output can be pasted into a ticket. It
-- hashes stored values in memory to classify them; it changes nothing.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/tools/s1-upload-token-preflight.sql
--
-- Write safety: one REPEATABLE READ, READ ONLY transaction (one snapshot for all
-- sections; PostgreSQL rejects any write), statement_timeout, lock_timeout,
-- ROLLBACK at the end, ON_ERROR_STOP.
--
-- Remediation context (not performed here): any remediation scrubs STORED COPIES
-- only and must never modify, expire or delete PaymentUploadToken rows, so no
-- customer link is revoked by it.

\set ON_ERROR_STOP on

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- 1. OutboxEvent rows still carrying an upload link: payload.uploadUrl or
--    payload.uploadToken holding a NON-EMPTY string. A key whose value is null or
--    empty carries nothing (pre-S1 consumers wrote such keys) and is not counted.
--    Counted per stored copy, by event, row status and token state.
-- ============================================================================

\echo '== 1. OutboxEvent stored upload links (database only)'
WITH copies AS (
  SELECT e."eventName" AS event_name, e.status::text AS row_status, k.key AS payload_key,
         substring(e.payload ->> k.key from '(?:^|[^0-9a-f])([0-9a-f]{64})(?:[/?#]|$)') AS raw
  FROM "OutboxEvent" e
  CROSS JOIN (VALUES ('uploadUrl'), ('uploadToken')) k(key)
  WHERE jsonb_typeof(e.payload -> k.key) = 'string' AND e.payload ->> k.key <> ''
)
SELECT c.event_name, c.row_status, c.payload_key,
       CASE WHEN c.raw IS NULL THEN 'malformed'
            WHEN t.id IS NULL THEN 'no_token_row'
            WHEN t."usedAt" IS NOT NULL THEN 'used'
            WHEN t."expiresAt" <= now() THEN 'expired'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') AND p."deletedAt" IS NULL THEN 'live_link'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') THEN 'live_submit_only'
            ELSE 'active_unusable' END AS token_state,
       count(*) AS copies
FROM copies c
LEFT JOIN "PaymentUploadToken" t ON t.token = encode(sha256(convert_to(c.raw, 'UTF8')), 'hex')
LEFT JOIN "Payment" p ON p.id = t."paymentId"
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- ============================================================================
-- 2. NotificationOutbox rows still carrying the token / link in payload
--    (uploadToken = WhatsApp order.transfer, uploadUrl = EMAIL payment.reminder;
--    non-empty strings only), per stored copy, by template, status and state.
-- ============================================================================

\echo '== 2. NotificationOutbox stored upload tokens / links in payload (database only)'
WITH copies AS (
  SELECT n.template, n.status::text AS row_status, k.key AS payload_key,
         substring(n.payload ->> k.key from '(?:^|[^0-9a-f])([0-9a-f]{64})(?:[/?#]|$)') AS raw
  FROM "NotificationOutbox" n
  CROSS JOIN (VALUES ('uploadUrl'), ('uploadToken')) k(key)
  WHERE jsonb_typeof(n.payload -> k.key) = 'string' AND n.payload ->> k.key <> ''
)
SELECT c.template, c.row_status, c.payload_key,
       CASE WHEN c.raw IS NULL THEN 'malformed'
            WHEN t.id IS NULL THEN 'no_token_row'
            WHEN t."usedAt" IS NOT NULL THEN 'used'
            WHEN t."expiresAt" <= now() THEN 'expired'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') AND p."deletedAt" IS NULL THEN 'live_link'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') THEN 'live_submit_only'
            ELSE 'active_unusable' END AS token_state,
       count(*) AS copies
FROM copies c
LEFT JOIN "PaymentUploadToken" t ON t.token = encode(sha256(convert_to(c.raw, 'UTF8')), 'hex')
LEFT JOIN "Payment" p ON p.id = t."paymentId"
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- ============================================================================
-- 3. NotificationOutbox.lastError that may contain a token (provider error text
--    echoing the request, persisted unscrubbed before S1). Rows, not tokens:
--    upload_link        : text contains an upload-link path followed by 32+ hex
--                         characters (the shape S1's redactUploadLinks removes)
--    bare_hex64_candidate: no such link, but a standalone 64-hex string. This is a
--                         CANDIDATE only — other 64-hex values (hashes, ids) match
--                         too; review before treating it as a token.
--    Ordinary error text matches neither and is not counted.
-- ============================================================================

\echo '== 3. NotificationOutbox.lastError possibly containing a token (rows)'
SELECT n.template, n.status::text AS row_status,
       count(*) FILTER (WHERE n."lastError" ~* '/(payment|payments/upload)/[0-9a-f]{32,}') AS upload_link,
       count(*) FILTER (WHERE n."lastError" !~* '/(payment|payments/upload)/[0-9a-f]{32,}'
                          AND n."lastError" ~* '(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)') AS bare_hex64_candidate
FROM "NotificationOutbox" n
WHERE n."lastError" ~* '/(payment|payments/upload)/[0-9a-f]{32,}'
   OR n."lastError" ~* '(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)'
GROUP BY 1, 2
ORDER BY 1, 2;

-- ============================================================================
-- 4. PaymentUploadToken rows by state (hash rows; not secret). Every row is
--    counted exactly once. These rows must NOT be modified by any remediation.
-- ============================================================================

\echo '== 4. PaymentUploadToken rows by state'
SELECT CASE WHEN t."usedAt" IS NOT NULL THEN 'used'
            WHEN t."expiresAt" <= now() THEN 'expired'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') AND p."deletedAt" IS NULL THEN 'active_live_link'
            WHEN p.status IN ('PENDING', 'WAITING_VERIFICATION') THEN 'active_live_submit_only'
            ELSE 'active_unusable' END AS token_state,
       count(*)              AS tokens,
       min(t."expiresAt")    AS earliest_expiry,
       max(t."expiresAt")    AS latest_expiry
FROM "PaymentUploadToken" t
LEFT JOIN "Payment" p ON p.id = t."paymentId"
GROUP BY 1
ORDER BY 1;

-- ============================================================================
-- 5. Two DIFFERENT expiry horizons (database only):
--    usable_stored_copies : stored plaintext copies (sections 1-2) whose token is
--        live_link or live_submit_only, and the latest expiry among them. After
--        that time no stored copy in the database can be used any more.
--    active_eligible_tokens : ALL active tokens whose payment can still take a
--        receipt (PENDING / WAITING_VERIFICATION, soft-deleted or not), whether or
--        not a plaintext copy of them is stored anywhere. This includes post-S1
--        tokens held only by customers, so it is usually later and must NOT be
--        read as the stored-copy horizon.
-- ============================================================================

\echo '== 5. Expiry horizons: usable stored copies vs all active eligible tokens'
WITH copies AS (
  SELECT substring(e.payload ->> k.key from '(?:^|[^0-9a-f])([0-9a-f]{64})(?:[/?#]|$)') AS raw
  FROM "OutboxEvent" e CROSS JOIN (VALUES ('uploadUrl'), ('uploadToken')) k(key)
  WHERE jsonb_typeof(e.payload -> k.key) = 'string' AND e.payload ->> k.key <> ''
  UNION ALL
  SELECT substring(n.payload ->> k.key from '(?:^|[^0-9a-f])([0-9a-f]{64})(?:[/?#]|$)')
  FROM "NotificationOutbox" n CROSS JOIN (VALUES ('uploadUrl'), ('uploadToken')) k(key)
  WHERE jsonb_typeof(n.payload -> k.key) = 'string' AND n.payload ->> k.key <> ''
),
usable_copies AS (
  SELECT t."expiresAt"
  FROM copies c
  JOIN "PaymentUploadToken" t ON t.token = encode(sha256(convert_to(c.raw, 'UTF8')), 'hex')
  JOIN "Payment" p ON p.id = t."paymentId"
  WHERE t."usedAt" IS NULL AND t."expiresAt" > now()
    AND p.status IN ('PENDING', 'WAITING_VERIFICATION')
),
eligible_tokens AS (
  SELECT t."expiresAt"
  FROM "PaymentUploadToken" t
  JOIN "Payment" p ON p.id = t."paymentId"
  WHERE t."usedAt" IS NULL AND t."expiresAt" > now()
    AND p.status IN ('PENDING', 'WAITING_VERIFICATION')
)
SELECT 'usable_stored_copies' AS horizon, count(*) AS items, max("expiresAt") AS latest_expiry FROM usable_copies
UNION ALL
SELECT 'active_eligible_tokens', count(*), max("expiresAt") FROM eligible_tokens;

ROLLBACK;
