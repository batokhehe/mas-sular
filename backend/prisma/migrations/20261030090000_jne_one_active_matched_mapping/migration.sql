-- At most ONE active MATCHED mapping per district.
--
-- The resolver answers a checkout with the district's active MATCHED row. Two such
-- rows would make that answer depend on row order. The approval and import tools
-- already refuse to create a second one; this makes the database refuse it too, for
-- every writer.
--
-- PARTIAL index: REVIEW_REQUIRED candidates, inactive rows and other statuses are
-- unrestricted (several may coexist, as the schema intends). Prisma's schema
-- language cannot express a WHERE clause, so this index exists ONLY in migrations:
-- a `prisma migrate dev` that proposes `DROP INDEX "JneDistrictMapping_one_active_matched_per_district"`
-- must have that statement removed. test/unit/jne-one-active-matched-migration.spec.ts
-- fails any later migration that drops it.
--
-- Fails (and changes nothing) if a district already has two active MATCHED rows;
-- check first with:
--   SELECT "districtId" FROM "JneDistrictMapping" WHERE status = 'MATCHED' AND "isActive" GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX "JneDistrictMapping_one_active_matched_per_district"
  ON "JneDistrictMapping" ("districtId")
  WHERE "status" = 'MATCHED' AND "isActive";
