/**
 * Create one admin-panel account with exactly one role: ADMIN, MANAGER or STAFF.
 *
 *   docker compose --env-file ./production.env -f docker-compose.production.yml run --rm --no-deps \
 *     backend node dist/prisma/create-admin.js --email person@example.com --name "Full Name" --role STAFF
 *
 * The password is then prompted for TWICE with hidden input. It is never accepted as
 * an argument or environment variable and is never printed. Requires an interactive
 * terminal (do not pass `-T`). Refuses SUPER_ADMIN/CUSTOMER/custom roles and an email
 * that already exists (an existing admin is never modified). Writes Admin + AdminRole
 * + an AuditTrail row in one transaction. Exit code 0 = created, 1 = refused/failed.
 * Implementation: ./bootstrap/admin-lifecycle.ts.
 */
import { PrismaClient } from '@prisma/client';
import { runCreateAdmin } from './bootstrap/admin-lifecycle';

void runCreateAdmin(process.argv.slice(2), { input: process.stdin, output: process.stdout }, () => new PrismaClient()).then((code) => {
  process.exitCode = code;
});
