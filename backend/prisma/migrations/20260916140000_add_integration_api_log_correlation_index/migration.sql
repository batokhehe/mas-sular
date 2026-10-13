-- Index the integration log's correlationId (P1 review finding 4).
--
-- The Admin free-text search matches this column - it holds the order number, the
-- courier AWB / cnote and the Midtrans order_id, i.e. the identifier an operator
-- actually pastes into the filter - and it was the only searched identifier column
-- without an index.
--
-- Additive: CREATE INDEX only. No table, column, constraint or row is altered, and
-- nothing is dropped, so `migrate deploy` is safe against a live database.

-- CreateIndex
CREATE INDEX "IntegrationApiLog_correlationId_idx" ON "IntegrationApiLog"("correlationId");

