-- Production-readiness H2: selector-based refresh-token lookup.
-- Refresh/logout used to bcrypt-compare the presented token against up to 100
-- active sessions (~25 s of blocked event loop per bogus request). A token is now
-- `<selector>.<secret>`; the selector is looked up by this unique index and only
-- that row's hash is checked.
--
-- Additive and non-destructive: existing rows keep selector NULL (a UNIQUE index
-- allows many NULLs) and are left untouched. Those legacy tokens cannot be
-- presented any more - the customer signs in again - and they expire on their own.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "selector" VARCHAR(32);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_selector_key" ON "RefreshToken"("selector");
