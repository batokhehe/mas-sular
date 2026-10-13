-- P2: product image gallery.
--
-- Additive: a new table, its foreign key and unique index, and a backfill INSERT.
-- No Product row or column is altered, and nothing is dropped, so `migrate deploy`
-- is safe against a live database.
--
-- Backfill: every existing product with a non-empty imageUrl gets its cover as
-- ProductImage sortOrder 0, with the url copied VERBATIM (legacy /products/*.jpg
-- values included). Soft-deleted products are included, so the invariant
-- Product.imageUrl = ProductImage(sortOrder 0).url holds for every row. The NOT
-- EXISTS guard makes the statement safe to re-run. gen_random_uuid() is built into
-- PostgreSQL 13+; the id column is text, like every other Prisma uuid() id.

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_sortOrder_key" ON "ProductImage"("productId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (data)
INSERT INTO "ProductImage" ("id", "productId", "url", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, p."id", p."imageUrl", 0, CURRENT_TIMESTAMP
FROM "Product" p
WHERE btrim(p."imageUrl") <> ''
  AND NOT EXISTS (SELECT 1 FROM "ProductImage" i WHERE i."productId" = p."id");
