/**
 * PAXELBOX-61AG.3.21 — proof harness for normalize-address-phone.
 *
 *   npx tsx prisma/tools/normalize-address-phone.verify.ts
 *
 * Runs the real tool against a THROWAWAY MySQL container. It never touches a
 * configured database: DATABASE_URL is overwritten with the container's URI
 * before @prisma/client is loaded, and the run aborts unless `SELECT DATABASE()`
 * returns the disposable name AND the Address table is empty.
 *
 * What it proves:
 *   1. dry run writes nothing at all
 *   2. apply repairs exactly the normalisable rows
 *   3. no column other than `phone` and `updatedAt` moves
 *   4. a second apply is a no-op (idempotent) and does NOT re-bump updatedAt
 *   5. the write guard refuses production and shared-development databases
 *
 * Every phone here is synthetic: 0812-0000-xxxx is not an allocated range.
 */
import { execSync } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const DB = 'e2e_phone_backfill';

/** id -> raw legacy value, and what the tool must decide about it. */
const FIXTURES: Array<{ id: string; phone: string; expect: 'NORMALIZE' | 'KEEP'; canonical?: string }> = [
  { id: 'fx1-national-08',      phone: '081200000001',        expect: 'NORMALIZE', canonical: '6281200000001' },
  { id: 'fx2-plus-62',          phone: '+6281200000002',      expect: 'NORMALIZE', canonical: '6281200000002' },
  { id: 'fx3-bare-8',           phone: '81200000003',         expect: 'NORMALIZE', canonical: '6281200000003' },
  { id: 'fx4-hyphenated',       phone: '0812-0000-0004',      expect: 'NORMALIZE', canonical: '6281200000004' },
  { id: 'fx5-spaced-plus-62',   phone: '+62 812 0000 0005',   expect: 'NORMALIZE', canonical: '6281200000005' },
  { id: 'fx6-already-canonical',phone: '6281200000006',       expect: 'KEEP' },
  { id: 'fx7-landline',         phone: '0211234567',          expect: 'KEEP' },  // valid ID number, not a mobile
  { id: 'fx8-malformed',        phone: 'ab12xyz!@#',          expect: 'KEEP' },  // mirrors the real legacy junk row
  { id: 'fx9-foreign',          phone: '+14155550100',        expect: 'KEEP' },
];

const EXPECT_NORMALIZE = FIXTURES.filter((f) => f.expect === 'NORMALIZE').length;

type Snapshot = Record<string, Record<string, unknown>>;

function snapshotOf(rows: Array<Record<string, unknown>>): Snapshot {
  const out: Snapshot = {};
  for (const r of rows) out[String(r.id)] = { ...r };
  return out;
}

/**
 * Millisecond-exact, because `updatedAt` is the whole question here. Plain
 * `String(date)` truncates to seconds and would hide a timestamp bump entirely.
 */
function cell(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Which columns differ, per row. */
function diff(before: Snapshot, after: Snapshot): Record<string, string[]> {
  const changed: Record<string, string[]> = {};
  for (const id of Object.keys(before)) {
    const cols = Object.keys(before[id]).filter(
      (c) => cell((before[id] as never)[c]) !== cell((after[id] as never)[c]),
    );
    if (cols.length) changed[id] = cols;
  }
  return changed;
}

async function main(): Promise<void> {
  const { MySqlContainer } = require('@testcontainers/mysql');

  console.log('starting disposable MySQL…');
  const container = await new MySqlContainer('mysql:8.4')
    .withDatabase(DB)
    .withUsername('backfill')
    .withUserPassword('backfill')
    .start();

  try {
    const uri: string = container.getConnectionUri();
    process.env.DATABASE_URL = uri;             // BEFORE @prisma/client loads
    process.env.NODE_ENV = 'test';

    console.log('applying migrations…');
    execSync('npx prisma migrate deploy', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: uri },
    });

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    // ---- isolation gate: refuse to continue unless this is the throwaway DB --
    const liveRows = (await prisma.$queryRawUnsafe('SELECT DATABASE() AS db')) as Array<{ db: string }>;
    const live = liveRows[0]?.db;
    assert.equal(live, DB, `isolation gate: connected to "${live}", expected "${DB}"`);
    assert.equal(await prisma.address.count(), 0, 'isolation gate: Address table is not empty');
    console.log(`isolation gate passed: database=${live}, Address rows=0\n`);

    // ------------------------------------------------------------- fixtures --
    await prisma.user.create({
      data: { id: 'fx-user', email: 'backfill-fixture@example.test', name: 'Backfill Fixture' },
    });
    for (const f of FIXTURES) {
      await prisma.address.create({
        data: {
          id: f.id,
          userId: 'fx-user',
          label: 'Rumah',
          recipientName: 'Fixture',
          phone: f.phone,
          fullAddress: 'Jl. Fixture No. 1',
          latitude: -6.9147444,
          longitude: 107.6098111,
        },
      });
    }

    const columns = { id: true, userId: true, label: true, recipientName: true, phone: true,
      fullAddress: true, notes: true, latitude: true, longitude: true, isDefault: true,
      addressDetail: true, provinceId: true, cityId: true, districtId: true, villageId: true,
      postalCode: true, createdAt: true, updatedAt: true, deletedAt: true } as const;

    const before = snapshotOf(await prisma.address.findMany({ select: columns }));
    const tool = require('./normalize-address-phone');

    // ---------------------------------------------------------- 1. dry run ---
    console.log('=== 1. DRY RUN ===');
    await tool.run([]);
    const afterDry = snapshotOf(await prisma.address.findMany({ select: columns }));
    assert.deepEqual(diff(before, afterDry), {}, 'dry run must not write anything');
    console.log('OK — dry run changed 0 columns on 0 rows\n');

    // ------------------------------------------------------------ 2. apply ---
    console.log('=== 2. APPLY ===');
    await tool.run(['--apply']);
    const afterApply = snapshotOf(await prisma.address.findMany({ select: columns }));
    const changed = diff(before, afterApply);

    // 3. field immutability. Assert the allowed SET rather than a guess about
    // updatedAt, then report what actually moved — the point is to measure the
    // timestamp, not to assume it.
    const ALLOWED = new Set(['phone', 'updatedAt']);
    for (const [id, cols] of Object.entries(changed)) {
      const forbidden = cols.filter((c) => !ALLOWED.has(c));
      assert.deepEqual(forbidden, [], `row ${id} changed forbidden column(s): ${forbidden.join(', ')}`);
      assert.ok(cols.includes('phone'), `row ${id} changed ${cols.join(', ')} but not phone`);
    }
    const bumped = Object.entries(changed).filter(([, cols]) => cols.includes('updatedAt')).map(([id]) => id);
    console.log(
      bumped.length
        ? `updatedAt BUMPED on ${bumped.length}/${Object.keys(changed).length} repaired row(s), e.g. ${bumped[0]}: ` +
            `${cell(before[bumped[0]].updatedAt)} -> ${cell(afterApply[bumped[0]].updatedAt)}`
        : 'updatedAt NOT bumped on any repaired row',
    );
    const repaired = Object.keys(changed).sort();
    assert.deepEqual(
      repaired,
      FIXTURES.filter((f) => f.expect === 'NORMALIZE').map((f) => f.id).sort(),
      'the wrong set of rows was repaired',
    );
    for (const f of FIXTURES) {
      const got = afterApply[f.id].phone;
      const want = f.expect === 'NORMALIZE' ? f.canonical : f.phone;
      assert.equal(got, want, `row ${f.id}: expected ${want}, got ${got}`);
    }
    console.log(`OK — ${repaired.length}/${EXPECT_NORMALIZE} rows repaired; only [phone, updatedAt] moved`);
    console.log(`OK — ${FIXTURES.length - repaired.length} rows left byte-identical (canonical + quarantined)\n`);

    // ------------------------------------------------------ 4. idempotency ---
    console.log('=== 3. SECOND APPLY (idempotency) ===');
    await tool.run(['--apply']);
    const afterSecond = snapshotOf(await prisma.address.findMany({ select: columns }));
    assert.deepEqual(diff(afterApply, afterSecond), {}, 'second apply must be a no-op');
    console.log('OK — second apply changed 0 columns (no re-write, no further updatedAt bump)\n');

    // ------------------------------------------------- 5. --ids allowlist ---
    // Three fresh legacy rows; only two are approved. The third proves the tool
    // repairs the allowlist and not "everything that looks repairable".
    console.log('=== 4. --ids ALLOWLIST ===');
    for (const [id, phone] of [['al1', '081200000011'], ['al2', '081200000012'], ['al3-excluded', '081200000013']]) {
      await prisma.address.create({
        data: { id, userId: 'fx-user', label: 'Rumah', recipientName: 'Fixture', phone,
          fullAddress: 'Jl. Fixture No. 1', latitude: -6.9147444, longitude: 107.6098111 },
      });
    }
    const beforeAllow = snapshotOf(await prisma.address.findMany({ select: columns }));

    // An id that is not a normalisable row must abort the whole run, not skip.
    for (const [badIds, why] of [
      ['al1,does-not-exist', 'unknown id'],
      ['al1,fx7-landline', 'id that is a quarantined landline'],
      ['al1,fx8-malformed', 'id that cannot be normalised'],
    ]) {
      let threw: Error | null = null;
      try { await tool.run(['--apply', `--ids=${badIds}`]); } catch (e) { threw = e as Error; }
      assert.ok(threw, `allowlist mismatch (${why}) did not abort`);
      assert.match(threw!.message, /allowlist does not match the database/, threw!.message);
      console.log(`OK — aborted on ${why}`);
    }
    assert.deepEqual(
      diff(beforeAllow, snapshotOf(await prisma.address.findMany({ select: columns }))), {},
      'an aborted allowlist run must leave every row untouched',
    );
    console.log('OK — aborted runs wrote nothing at all');

    await tool.run(['--apply', '--ids=al1,al2']);
    const afterAllow = snapshotOf(await prisma.address.findMany({ select: columns }));
    assert.deepEqual(Object.keys(diff(beforeAllow, afterAllow)).sort(), ['al1', 'al2'],
      'only the allowlisted rows may change');
    assert.equal(afterAllow['al3-excluded'].phone, '081200000013',
      'the excluded row must keep its legacy value');
    console.log('OK — 2 allowlisted rows repaired; the 3rd normalisable row left untouched');

    // -- compare-and-set failure must roll the WHOLE transaction back ---------
    // Naming a row twice makes the second update's CAS miss: the first update has
    // already moved the phone off the value the WHERE clause expects. That is a
    // genuine mid-transaction CAS failure with partial progress already made —
    // reachable through the public interface, so it exercises the real rollback.
    const beforeCas = snapshotOf(await prisma.address.findMany({ select: columns }));
    let casThrew: Error | null = null;
    try { await tool.run(['--apply', '--ids=al3-excluded,al3-excluded']); } catch (e) { casThrew = e as Error; }
    assert.ok(casThrew, 'a failed compare-and-set did not abort the run');
    assert.match(casThrew!.message, /expected 2 affected row\(s\), got 1/, casThrew!.message);
    assert.deepEqual(
      diff(beforeCas, snapshotOf(await prisma.address.findMany({ select: columns }))), {},
      'CAS failure must roll back the row that HAD already been updated',
    );
    assert.equal(
      (await prisma.address.findUnique({ where: { id: 'al3-excluded' } })).phone, '081200000013',
      'the partially-updated row must be back at its original value',
    );
    console.log('OK — CAS failure rolled back the already-updated row; 0 columns committed\n');

    // Re-running the SAME approved command must be a clean no-op, not an error:
    // already-canonical is the approved end state, not allowlist drift.
    await tool.run(['--apply', '--ids=al1,al2']);
    assert.deepEqual(
      diff(afterAllow, snapshotOf(await prisma.address.findMany({ select: columns }))), {},
      're-running an approved allowlist must change nothing',
    );
    console.log('OK — re-running the same allowlist exits cleanly and changes 0 columns\n');

    await prisma.$disconnect();

    // ----------------------------------------------------- 6. write guards ---
    // Real protected names, created inside the throwaway container. Nothing here
    // can reach a real host: only the container's port is listening.
    console.log('=== 5. WRITE GUARDS ===');
    const root = `mysql://root:${container.getRootPassword()}@${container.getHost()}:${container.getPort()}`;
    const { PrismaClient: RootClient } = require('@prisma/client');
    const admin = new RootClient({ datasources: { db: { url: `${root}/${DB}` } } });
    for (const name of ['mas_sular', 'u122587529_dev_ecommerce', 'ecommerce_staging']) {
      await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
    }
    await admin.$disconnect();

    // The matrix matters more than any single case: production must refuse even
    // with the full approved-run arguments, and shared dev must refuse when only
    // half the confirmation is present.
    const IDS = 'some-id-1,some-id-2';
    const CASES: Array<[string, string[], string]> = [
      ['mas_sular', ['--apply'], 'production, bare apply'],
      ['mas_sular', ['--apply', '--target=mas_sular', `--ids=${IDS}`], 'production, WITH target+ids — must still refuse'],
      ['u122587529_dev_ecommerce', ['--apply'], 'shared dev, bare apply'],
      ['u122587529_dev_ecommerce', ['--apply', `--ids=${IDS}`], 'shared dev, ids but no --target'],
      ['u122587529_dev_ecommerce', ['--apply', '--target=u122587529_dev_ecommerce'], 'shared dev, target but no --ids'],
      ['u122587529_dev_ecommerce', ['--apply', '--target=wrong_name', `--ids=${IDS}`], 'shared dev, --target names a different database'],
      ['ecommerce_staging', ['--apply', '--target=ecommerce_staging', `--ids=${IDS}`], 'unknown/non-disposable name, even with target+ids'],
    ];

    for (const [name, args, why] of CASES) {
      process.env.DATABASE_URL = `${root}/${name}`;
      let threw: Error | null = null;
      try {
        await tool.run(args);
      } catch (e) {
        threw = e as Error;
      }
      assert.ok(threw, `guard did NOT fire for ${name} (${why})`);
      assert.match(threw!.message, /refusing to apply/, `wrong failure for ${name}: ${threw!.message}`);
      console.log(`OK — refused (${why})`);
    }

    // NODE_ENV=production must refuse even a disposable name.
    process.env.DATABASE_URL = uri;
    process.env.NODE_ENV = 'production';
    let prodThrew: Error | null = null;
    try {
      await tool.run(['--apply']);
    } catch (e) {
      prodThrew = e as Error;
    }
    assert.ok(prodThrew, 'guard did NOT fire for NODE_ENV=production');
    assert.match(prodThrew!.message, /NODE_ENV=production/);
    console.log(`OK — refused NODE_ENV=production: ${prodThrew!.message}`);

    console.log('\nALL CHECKS PASSED');
  } finally {
    await container.stop();
    console.log('disposable MySQL stopped and removed.');
  }
}

main().catch((e: Error) => {
  console.error(`\nVERIFY FAILED: ${e.message}`);
  process.exitCode = 1;
});
