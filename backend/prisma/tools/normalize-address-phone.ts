/**
 * PAXELBOX-61AG.3.21 — normalise legacy Address.phone to the canonical `628…` form.
 *
 * 61AG.3.20 made the address phone Indonesian-mobile-only and canonical on write.
 * Rows written before that are still in whatever shape the customer typed. This
 * tool repairs them.
 *
 * DATA migration, not a schema migration: it touches one column and adds no
 * constraint. A CHECK constraint is deliberately NOT part of this — at least one
 * legacy row cannot be normalised, so a constraint would fail to apply.
 *
 *   DRY RUN (default, no writes):
 *     npx tsx prisma/tools/normalize-address-phone.ts
 *   APPLY to a disposable database:
 *     npx tsx prisma/tools/normalize-address-phone.ts --apply
 *   APPLY to a known shared database (reviewed, row-by-row):
 *     npx tsx prisma/tools/normalize-address-phone.ts --apply \
 *       --target=<database> --ids=<id,id,…>
 *
 * Refuses to write unless the connected database proves itself disposable, or is
 * a known shared database named by --target AND narrowed to an explicit --ids
 * allowlist. Production is refused unconditionally: no flag lifts it.
 * Never guesses: a value that cannot be normalised is QUARANTINED, untouched.
 * Never prints a full phone number.
 *
 * `updatedAt` IS BUMPED on every repaired row, and that is deliberate. The column
 * is a plain DATETIME(3) with no ON UPDATE clause, so `@updatedAt` is applied by
 * the Prisma client — a raw UPDATE could have preserved it. The row genuinely
 * changed, so freezing the timestamp would hide the repair from anyone auditing
 * it later. Nothing reads Address.updatedAt: the compare-and-swap concurrency
 * guards in the codebase are on AdminRole and Shipment, not Address. The tool
 * reports the timestamp change instead of claiming only `phone` moved.
 */
import { PrismaClient } from '@prisma/client';
import { maskPhone, normalizeIndonesianMobile, normalizePhoneNumber } from '../../src/common/utils/phone.util';

/** Production. No flag, argument or environment makes these writable. */
const PRODUCTION_DATABASES = ['mas_sular'];

/**
 * Shared databases real people work against. Writable only under an explicit
 * reviewed allowlist run: you must name the database with --target AND name every
 * row with --ids. Neither alone is enough, and a bare `--apply` still refuses.
 */
const SHARED_DATABASES: Record<string, string> = {
  u122587529_dev_ecommerce: 'shared development',
};

/** A database is freely writable only if its name says it is throwaway. */
const DISPOSABLE_DATABASE = /^(e2e|tc|test|phone|backfill)[_-]|_(test|e2e|disposable)$|disposable/i;

type Action = 'NORMALIZE' | 'ALREADY_CANONICAL' | 'QUARANTINE';

interface Row {
  id: string;
  action: Action;
  reason: string;
  /** Masked. A full number never leaves this tool. */
  before: string;
  after: string | null;
}

/**
 * `maskPhone` is the project's masker and stays the one used here. It assumes a
 * plausible number though, so guard the legacy junk this tool exists to find.
 */
function safeMask(value: string | null | undefined): string {
  if (!value || !value.trim()) return '(empty)';
  return maskPhone(value);
}

function classify(phone: string): { action: Action; reason: string; canonical: string | null } {
  let canonical: string | null = null;
  try {
    canonical = normalizeIndonesianMobile(phone);
  } catch {
    canonical = null;
  }
  if (canonical && canonical === phone) {
    return { action: 'ALREADY_CANONICAL', reason: 'already canonical 628…', canonical };
  }
  if (canonical) {
    return { action: 'NORMALIZE', reason: 'valid Indonesian mobile in a non-canonical form', canonical };
  }
  // Distinguish "a real number, but not a mobile" from "not a number at all", so
  // review knows whether a human can fix it or the data is simply junk.
  try {
    normalizePhoneNumber(phone);
    return { action: 'QUARANTINE', reason: 'valid Indonesian number but NOT a mobile (landline)', canonical: null };
  } catch {
    return { action: 'QUARANTINE', reason: 'cannot be normalised — malformed or foreign', canonical: null };
  }
}

/**
 * Prove the target is disposable before any write.
 *
 * Multiple independent checks, because one is a single point of failure: the
 * environment, an explicit deny list, and the live `SELECT DATABASE()` name —
 * not the hostname, which is trivially the same for a dev and a prod instance.
 */
async function assertWritable(
  prisma: PrismaClient,
  opts: { target: string | null; ids: string[] },
): Promise<{ database: string; mode: 'disposable' | 'allowlist' }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to apply: NODE_ENV=production');
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ db: string | null }>>('SELECT DATABASE() AS db');
  const database = rows[0]?.db ?? null;
  if (!database) {
    throw new Error('refusing to apply: could not determine the connected database');
  }
  if (PRODUCTION_DATABASES.includes(database)) {
    throw new Error(`refusing to apply: "${database}" is a production database`);
  }
  if (DISPOSABLE_DATABASE.test(database)) {
    return { database, mode: 'disposable' };
  }
  if (SHARED_DATABASES[database]) {
    // Two independent confirmations, because "I meant this database" and "I meant
    // these rows" are different mistakes. A pattern-matched bulk UPDATE against
    // shared data is exactly what this refuses to offer.
    if (opts.target !== database) {
      throw new Error(
        `refusing to apply: "${database}" is the ${SHARED_DATABASES[database]} database. ` +
          `An approved run must name it explicitly: --target=${database}`,
      );
    }
    if (opts.ids.length === 0) {
      throw new Error(
        `refusing to apply: "${database}" may only be written through an explicit row ` +
          'allowlist. Pass --ids=<id,id,…>; this tool will not bulk-update shared data.',
      );
    }
    return { database, mode: 'allowlist' };
  }
  throw new Error(
    `refusing to apply: "${database}" does not look disposable. This tool writes only to ` +
      'throwaway databases, or to a known shared database under --target with an explicit --ids allowlist.',
  );
}

function argValue(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const apply = argv.includes('--apply');
  const target = argValue(argv, '--target');
  const ids = (argValue(argv, '--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const prisma = new PrismaClient();

  try {
    const database = (await prisma.$queryRawUnsafe<Array<{ db: string | null }>>('SELECT DATABASE() AS db'))[0]?.db;
    console.log(`[normalize-address-phone] database=${database ?? '(unknown)'} mode=${apply ? 'APPLY' : 'DRY RUN'}`);
    if (ids.length) console.log(`allowlist: ${ids.length} explicit row id(s)`);

    // Guard FIRST, before a single row is read. Checking later would let the tool
    // fail on some unrelated error against a protected database and leave the
    // reader unsure whether the guard would have held at all.
    if (apply) {
      const w = await assertWritable(prisma, { target, ids });
      console.log(`write guard passed for "${w.database}" (${w.mode} mode)`);
    }

    const addresses = await prisma.address.findMany({
      where: { deletedAt: null },
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });

    const rows: Row[] = addresses.map((a) => {
      const { action, reason, canonical } = classify(a.phone);
      return { id: a.id, action, reason, before: safeMask(a.phone), after: canonical ? maskPhone(canonical) : null };
    });

    const normalizable = addresses.filter((a) => classify(a.phone).action === 'NORMALIZE');

    // With an allowlist, the approved ids are the whole population. An id that has
    // vanished or turned unrepairable means the approval no longer describes
    // reality, so the run stops rather than quietly doing 5 of 6.
    //
    // An id that is ALREADY canonical is not drift — it is the approved end state,
    // reached by an earlier run of this same command. It is skipped, so re-running
    // an approved backfill is a clean no-op instead of an error.
    let toNormalize = normalizable;
    if (ids.length) {
      const byId = new Map(addresses.map((a) => [a.id, a]));
      const problems: string[] = [];
      const satisfied: string[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) { problems.push(`${id}: not found (or soft-deleted)`); continue; }
        const { action, reason } = classify(row.phone);
        if (action === 'ALREADY_CANONICAL') { satisfied.push(id); continue; }
        if (action !== 'NORMALIZE') problems.push(`${id}: classified ${action} — ${reason}`);
      }
      if (problems.length) {
        throw new Error(`allowlist does not match the database:\n  ${problems.join('\n  ')}`);
      }
      if (satisfied.length) {
        console.log(`note: ${satisfied.length} allowlisted row(s) are already canonical — nothing to do for them`);
      }
      toNormalize = ids.filter((id) => !satisfied.includes(id)).map((id) => byId.get(id)!);
      const outside = normalizable.filter((a) => !ids.includes(a.id)).map((a) => a.id);
      if (outside.length) {
        console.log(`note: ${outside.length} further normalisable row(s) are NOT in the allowlist and stay untouched`);
      }
    }
    const summary = {
      total: rows.length,
      normalize: rows.filter((r) => r.action === 'NORMALIZE').length,
      alreadyCanonical: rows.filter((r) => r.action === 'ALREADY_CANONICAL').length,
      quarantine: rows.filter((r) => r.action === 'QUARANTINE').length,
    };

    console.log('\nid        action             before           after            reason');
    console.log('-'.repeat(100));
    for (const r of rows) {
      console.log(
        r.id.slice(0, 8).padEnd(10) +
          r.action.padEnd(19) +
          r.before.padEnd(17) +
          (r.after ?? '(unchanged)').padEnd(17) +
          r.reason,
      );
    }
    console.log(`\nsummary: ${JSON.stringify(summary)}`);

    if (!apply) {
      console.log('\nDRY RUN — no rows were written. Re-run with --apply to write.');
      return 0;
    }

    console.log(`\napplying ${toNormalize.length} update(s)…`);

    let affected = 0;
    await prisma.$transaction(async (tx) => {
      for (const a of toNormalize) {
        const canonical = normalizeIndonesianMobile(a.phone);
        // Compare-and-set on the OLD value: a row changed since the preview is
        // skipped rather than overwritten, and the count check then aborts.
        const res = await tx.address.updateMany({
          where: { id: a.id, phone: a.phone },
          data: { phone: canonical },
        });
        affected += res.count;
      }
      if (affected !== toNormalize.length) {
        throw new Error(
          `expected ${toNormalize.length} affected row(s), got ${affected} — rolling back`,
        );
      }
    });

    // Post-condition: everything that was normalisable is now canonical, and the
    // quarantined rows are exactly as many as before.
    const after = await prisma.address.findMany({ where: { deletedAt: null }, select: { id: true, phone: true } });
    const stillNonCanonical = after.filter((a) => classify(a.phone).action === 'NORMALIZE').length;
    const quarantined = after.filter((a) => classify(a.phone).action === 'QUARANTINE').length;

    console.log(`applied: ${affected} row(s) updated`);
    console.log(`verification: remaining non-canonical=${stillNonCanonical} quarantined=${quarantined}`);
    if (ids.length) {
      // Scoped run: the promise is about the allowlisted rows. Rows deliberately
      // left out must NOT be counted as a failure here.
      const missed = after.filter((a) => ids.includes(a.id) && classify(a.phone).action !== 'ALREADY_CANONICAL');
      if (missed.length) {
        throw new Error(`post-condition failed: ${missed.length} allowlisted row(s) are not canonical`);
      }
    } else if (stillNonCanonical !== 0) {
      throw new Error('post-condition failed: normalisable rows remain');
    }
    if (quarantined !== summary.quarantine) {
      throw new Error('post-condition failed: quarantined row count changed');
    }
    console.log('OK');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  run()
    .then((code) => { process.exitCode = code; })
    .catch((e: Error) => {
      console.error(`[normalize-address-phone] ${e.message}`);
      process.exitCode = 1;
    });
}
