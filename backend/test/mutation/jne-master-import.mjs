// Mutation checks for the JNE master import. Each mutant removes one protection from the
// source, and the tests must notice. A surviving mutant means a guard nothing is testing.
//
// Runs on a CI runner (.github/workflows/jne-master-import.yml), never on the production
// host: every mutant is a Jest run, and the atomicity mutants start a PostgreSQL container.
//
//   node test/mutation/jne-master-import.mjs           run every mutant
//   node test/mutation/jne-master-import.mjs --check   only confirm every mutant still applies
//
// Tests run transpile-only: a mutant must fail on behaviour, not on a type error.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = 'prisma/tools/jne-master-plan.ts';
const IMPORT = 'prisma/tools/import-jne-master.ts';

const transform = { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true, diagnostics: false }] };
const unitConfig = JSON.stringify({
  rootDir: BACKEND,
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup/no-external-network.ts'],
  transform,
});
const integrationConfig = JSON.stringify({
  rootDir: BACKEND,
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  testEnvironment: 'node',
  testTimeout: 120_000,
  maxWorkers: 1,
  transform,
});

const UNIT = 'unit';
const INTEGRATION = 'integration';

const MUTANTS = [
  // ---- origin protection
  {
    name: 'origin: updateMany no longer scoped to the kind',
    file: IMPORT,
    from: 'where: { id: { in: ids }, kind },',
    to: 'where: { id: { in: ids } },',
    suites: [UNIT],
  },
  {
    name: 'origin: renaming update no longer scoped to the kind',
    file: IMPORT,
    from: 'where: { id, kind },',
    to: 'where: { id },',
    suites: [UNIT],
  },
  {
    name: 'origin: deactivation no longer scoped to the kind',
    file: IMPORT,
    from: 'where: { id: { in: ids }, kind: again.kind, isActive: true }',
    to: 'where: { id: { in: ids }, isActive: true }',
    suites: [UNIT],
  },
  {
    name: 'origin: post-write fingerprint check removed',
    file: IMPORT,
    from: "if (protectedFingerprintOf(plan, after) !== plan.protectedFingerprint) fail(`the ${plan.protectedKind} master changed`);",
    to: '',
    suites: [UNIT],
  },
  {
    name: 'origin: fingerprint no longer part of the plan hash',
    file: PLAN,
    from: 'protectedFingerprint: plan.protectedFingerprint,\n  };',
    to: '};',
    suites: [UNIT],
  },
  {
    name: 'origin: fingerprint ignores rawName',
    file: PLAN,
    from: 'r.source, r.rawName, r.normalizedName,',
    to: 'r.source, r.normalizedName,',
    suites: [UNIT],
  },
  {
    name: 'origin: active-origin guard removed',
    file: PLAN,
    from: 'if (!origin?.isActive) {',
    to: 'if (false) {',
    suites: [UNIT],
  },
  {
    name: 'origin: guard satisfied by a DESTINATION row',
    file: PLAN,
    from: 'const origin = protectedRows.find((e) => e.code === originCode);',
    to: 'const origin = input.existing.find((e) => e.code === originCode);',
    suites: [UNIT],
  },
  // ---- mapping protection
  {
    name: 'mapping: rename under MATCHED no longer blocks',
    file: PLAN,
    from: "if (active.some((m) => m.status === 'MATCHED') && !approved) {",
    to: 'if (false) {',
    suites: [UNIT],
  },
  {
    name: 'mapping: review ignores the old name',
    file: PLAN,
    from: 'const approved = r !== undefined && r.from === u.fromRawName && r.to === u.seed.rawName;',
    to: 'const approved = r !== undefined && r.to === u.seed.rawName;',
    suites: [UNIT],
  },
  {
    name: 'mapping: review ignores the new name',
    file: PLAN,
    from: 'const approved = r !== undefined && r.from === u.fromRawName && r.to === u.seed.rawName;',
    to: 'const approved = r !== undefined && r.from === u.fromRawName;',
    suites: [UNIT],
  },
  {
    name: 'mapping: any review of the code is enough',
    file: PLAN,
    from: 'const approved = r !== undefined && r.from === u.fromRawName && r.to === u.seed.rawName;',
    to: 'const approved = r !== undefined;',
    suites: [UNIT],
  },
  {
    name: 'mapping: stale reviews tolerated',
    file: PLAN,
    from: "block('REVIEWED_RENAME_NOT_PENDING',",
    to: "void ('REVIEWED_RENAME_NOT_PENDING',",
    suites: [UNIT],
  },
  {
    name: 'mapping: post-write mapping check removed',
    file: IMPORT,
    from: "if (mappingsKey(before) !== mappingsKey(after)) fail('a mapping changed');",
    to: '',
    suites: [UNIT],
  },
  // ---- atomicity
  {
    name: 'atomic: import outside any transaction',
    file: IMPORT,
    from: "await store.$transaction(\n    async (tx) => {\n      const before = await readMasterState(tx);",
    to: "await (async (fn: (tx: MasterStore) => Promise<void>, _o: unknown) => fn(store))(\n    async (tx) => {\n      const before = await readMasterState(tx);",
    suites: [UNIT, INTEGRATION],
  },
  {
    name: 'atomic: import no longer Serializable',
    file: IMPORT,
    from: "verifyWritten(again, before, await readMasterState(tx));\n    },\n    { timeout: WRITE_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },",
    to: 'verifyWritten(again, before, await readMasterState(tx));\n    },\n    { timeout: WRITE_TIMEOUT_MS },',
    suites: [UNIT],
  },
  {
    name: 'atomic: plan not recomputed inside the transaction',
    file: IMPORT,
    from: 'if (again.planSha256 !== plan.planSha256 || again.blockers.length > 0) {',
    to: 'if (false) {',
    suites: [UNIT],
  },
  {
    name: 'atomic: short updateMany count ignored',
    file: IMPORT,
    from: 'if (count !== ids.length) throw new MasterChangedError(`updated ${count} of ${ids.length} row(s)`);',
    to: '',
    suites: [UNIT],
  },
  {
    name: 'atomic: post-write verification skipped',
    file: IMPORT,
    from: 'verifyWritten(again, before, await readMasterState(tx));',
    to: '',
    suites: [UNIT],
  },
  {
    name: 'atomic: rows outside the plan not verified',
    file: IMPORT,
    from: "fail('a row outside the plan changed');",
    to: '',
    suites: [UNIT],
  },
  {
    name: 'atomic: dry run not read-only',
    file: IMPORT,
    from: "await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');",
    to: '',
    suites: [UNIT, INTEGRATION],
  },
  {
    name: 'atomic: plan hash no longer bound to the target',
    file: PLAN,
    from: "target: [target.jneEnvironment ?? 'sandbox', target.jneBaseUrl ?? null, target.jneOriginCode?.trim() ?? null],",
    to: '',
    suites: [UNIT],
  },
];

function run(suite) {
  const config = suite === UNIT ? unitConfig : integrationConfig;
  const pattern = suite === UNIT ? 'test/unit/jne-master-import' : 'test/integration/jne-master-import';
  const result = spawnSync('node_modules/.bin/jest', ['--config', config, '--runInBand', '--silent', pattern], { cwd: BACKEND, encoding: 'utf8' });
  return result.status === 0;
}

const checkOnly = process.argv.includes('--check');
const notApplicable = MUTANTS.filter((m) => {
  const source = readFileSync(join(BACKEND, m.file), 'utf8');
  return source.split(m.from).length !== 2;
});
for (const m of notApplicable) console.error(`DOES NOT APPLY (must match exactly once): ${m.name}`);
if (notApplicable.length > 0) process.exit(2);
console.log(`${MUTANTS.length} mutants apply`);
if (checkOnly) process.exit(0);

for (const suite of [UNIT, INTEGRATION]) {
  if (!run(suite)) {
    console.error(`baseline ${suite} tests fail: mutation results would mean nothing`);
    process.exit(2);
  }
}
console.log('baseline passes');

const survived = [];
for (const m of MUTANTS) {
  const path = join(BACKEND, m.file);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace(m.from, () => m.to));
  try {
    const alive = m.suites.filter((s) => run(s));
    if (alive.length > 0) {
      survived.push(m.name);
      console.log(`SURVIVED  ${m.name} (${alive.join(', ')})`);
    } else {
      console.log(`killed    ${m.name}`);
    }
  } finally {
    writeFileSync(path, original);
  }
}

console.log(`${MUTANTS.length - survived.length}/${MUTANTS.length} killed`);
process.exit(survived.length > 0 ? 1 : 0);
