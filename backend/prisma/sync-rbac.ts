/**
 * Bring an existing database's roles/permissions/system-role grants in line with
 * prisma/bootstrap/permission-catalogue.ts. DRY RUN BY DEFAULT - it prints the plan
 * and writes nothing unless `--apply` is given.
 *
 *   docker compose --env-file ./production.env -f docker-compose.production.yml run --rm \
 *     backend-migrate node node_modules/tsx/dist/cli.mjs prisma/sync-rbac.ts            # plan only
 *   ... prisma/sync-rbac.ts --apply                                                      # write
 *
 * Take (and verify) a backup before --apply on a production database. The script
 * creates missing roles/permissions, adds missing grants, and removes grants on the
 * code-owned system roles that the matrix does not contain. It never deletes a
 * permission row, a custom role, an admin, or a user; legacy permission rows (the
 * retired `orders.view` family) are only reported.
 */
import { PrismaClient } from '@prisma/client';
import { applyRbacPlan, planRbacSync } from './bootstrap/rbac';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const plan = await planRbacSync(prisma);
    console.log(`[sync-rbac] mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
    console.log(`[sync-rbac] missing roles:       ${plan.missingRoles.length ? plan.missingRoles.join(', ') : '-'}`);
    console.log(`[sync-rbac] missing permissions: ${plan.missingPermissions.length}`);
    for (const p of plan.missingPermissions) console.log(`    + ${p.subject}.${p.action}`);
    console.log(`[sync-rbac] grants to add:       ${plan.grantsToAdd.length}`);
    for (const g of plan.grantsToAdd) console.log(`    + ${g}`);
    console.log(`[sync-rbac] grants to remove:    ${plan.grantsToRemove.length}`);
    for (const g of plan.grantsToRemove) console.log(`    - ${g}`);
    console.log(`[sync-rbac] legacy permission rows (reported only, not deleted): ${plan.legacyPermissions.length}`);
    for (const p of plan.legacyPermissions) console.log(`    ~ ${p}`);
    if (apply) {
      await applyRbacPlan(prisma, plan);
      console.log('[sync-rbac] applied.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`[sync-rbac] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
