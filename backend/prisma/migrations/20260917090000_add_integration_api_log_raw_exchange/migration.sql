-- Exact external API exchange for the SUPER_ADMIN Integration Logs detail view.
--
-- rawEndpoint / rawRequestBody / rawResponseBody hold the request URL and bodies
-- EXACTLY as sent to / received from the provider: no redaction, masking,
-- truncation or reformatting. They contain provider credentials and personal data.
-- The sanitized JSON columns are unchanged and keep their redaction policy.
--
-- Additive: nullable columns only. No existing column, constraint, index or row is
-- altered, and nothing is dropped, so `migrate deploy` is safe against a live
-- database. Existing rows keep NULL (their raw exchange was never captured).

-- AlterTable
ALTER TABLE "IntegrationApiLog" ADD COLUMN "rawEndpoint" TEXT,
ADD COLUMN "rawRequestBody" TEXT,
ADD COLUMN "rawResponseBody" TEXT;
