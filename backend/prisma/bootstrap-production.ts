/**
 * PRODUCTION database bootstrap - run ONCE, after `prisma migrate deploy`, on a
 * fresh production database. Safe to re-run: it never changes an existing admin.
 *
 * Creates the role/permission catalogue and the first Super Admin from operator
 * input. Creates NO demo data (no products, voucher, bank account or outlet).
 *
 * On the VPS (credentials read from the operator's shell, never typed inline):
 *
 *   read -rp  'Admin email: '    BOOTSTRAP_ADMIN_EMAIL && export BOOTSTRAP_ADMIN_EMAIL
 *   read -rsp 'Admin password: ' BOOTSTRAP_ADMIN_PASSWORD && echo && export BOOTSTRAP_ADMIN_PASSWORD
 *   docker compose --env-file ./production.env -f docker-compose.production.yml run --rm \
 *     -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
 *     backend-migrate node node_modules/tsx/dist/cli.mjs prisma/bootstrap-production.ts
 *   unset BOOTSTRAP_ADMIN_PASSWORD
 *
 * Exit code 0 = created or already present (unchanged); 1 = refused or failed.
 */
import { PrismaClient } from '@prisma/client';
import { BootstrapError, bootstrapProduction, readBootstrapCredentials } from './bootstrap/production-bootstrap';

async function main(): Promise<void> {
  // Validated BEFORE any database connection: a refusal touches nothing.
  const credentials = readBootstrapCredentials(process.env);
  const prisma = new PrismaClient();
  try {
    const outcome = await bootstrapProduction(prisma, credentials);
    if (outcome.admin === 'created') {
      console.log(`[bootstrap] roles/permissions ensured (${outcome.permissions} permissions); Super Admin CREATED: ${outcome.email}`);
    } else {
      console.log(`[bootstrap] roles/permissions ensured (${outcome.permissions} permissions); admin ${outcome.email} already exists - left UNCHANGED`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof BootstrapError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(`[bootstrap] REFUSED/FAILED: ${message}`);
  process.exit(1);
});
