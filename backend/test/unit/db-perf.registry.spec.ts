import { queryNameFromSql } from '../../src/infrastructure/logging/db-perf.registry';

/**
 * Regression for the MySQL -> PostgreSQL migration (Class B: SILENT failures).
 *
 * The Performance Center groups database timings by a name derived from the SQL
 * Prisma emits. The original parser only understood MySQL's backtick form
 * (`db`.`Table`). PostgreSQL emits "public"."Table", which that parser could not
 * match — so every query would have collapsed to the bare verb ("SELECT",
 * "UPDATE"), silently blanking per-table timings with no error anywhere.
 *
 * Both dialects are accepted: PostgreSQL is what runs now, and the MySQL form is
 * kept so historical/mixed log lines still resolve to a table name.
 */
describe('queryNameFromSql — dialect-agnostic table naming', () => {
  describe('PostgreSQL (the live dialect)', () => {
    it('names a schema-qualified table', () => {
      expect(queryNameFromSql('SELECT "id" FROM "public"."OutboxEvent" WHERE "status" = $1')).toBe('SELECT OutboxEvent');
    });

    it('names a bare quoted table', () => {
      expect(queryNameFromSql('UPDATE "NotificationOutbox" SET "lockedBy" = $1')).toBe('UPDATE NotificationOutbox');
    });

    it('names an INSERT target', () => {
      expect(queryNameFromSql('INSERT INTO "public"."Order" ("id") VALUES ($1)')).toBe('INSERT Order');
    });

    it('preserves PascalCase exactly (no case folding in the label)', () => {
      expect(queryNameFromSql('SELECT * FROM "ProductInventory" FOR UPDATE')).toBe('SELECT ProductInventory');
    });

    it('falls back to an unquoted identifier', () => {
      expect(queryNameFromSql('SELECT * FROM SystemLog')).toBe('SELECT SystemLog');
    });
  });

  describe('MySQL (legacy log lines)', () => {
    it('still names a backtick-quoted, db-qualified table', () => {
      expect(queryNameFromSql('SELECT * FROM `app`.`Order` WHERE 1')).toBe('SELECT Order');
    });
  });

  describe('degenerate input', () => {
    it('returns the bare verb when there is no table', () => {
      expect(queryNameFromSql('BEGIN')).toBe('BEGIN');
    });

    it('does not throw on empty or nullish SQL', () => {
      expect(queryNameFromSql('')).toBe('QUERY');
      expect(queryNameFromSql(undefined as unknown as string)).toBe('QUERY');
    });
  });
});
