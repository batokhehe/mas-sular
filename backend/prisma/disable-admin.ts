/**
 * Disable (never delete) one admin-panel account by email: sets isActive=false and
 * nothing else - roles are kept. Takes effect on the admin's next request.
 *
 *   docker compose --env-file ./production.env -f docker-compose.production.yml run --rm --no-deps \
 *     backend node dist/prisma/disable-admin.js --email person@example.com
 *
 * Shows the target and asks for the email to be typed again (interactive terminal
 * required; `--yes` skips the confirmation). Refuses an unknown or already-inactive
 * admin and the last active SUPER_ADMIN. Writes an AuditTrail row in the same
 * transaction. Exit code 0 = disabled, 1 = refused/failed.
 * Implementation: ./bootstrap/admin-lifecycle.ts.
 */
import { PrismaClient } from '@prisma/client';
import { runDisableAdmin } from './bootstrap/admin-lifecycle';

void runDisableAdmin(process.argv.slice(2), { input: process.stdin, output: process.stdout }, () => new PrismaClient()).then((code) => {
  process.exitCode = code;
});
