/**
 * prisma/seed.ts is a DEVELOPMENT seed: it creates admin@test.com with the password
 * `admin` (and resets it on every run), demo products with invented ratings, an
 * active demo voucher, a placeholder bank account shown to customers, and a
 * "Local Dev Outlet". None of that may ever reach a production database.
 *
 * The migrator image runs with NODE_ENV=production, so this guard stops the dev seed
 * there; production databases are initialised with prisma/bootstrap-production.ts.
 * The local compose stack sets NODE_ENV=development on its migrator explicitly.
 */
export class DevSeedRefusedError extends Error {
  constructor(script: string) {
    super(
      `${script} is a DEVELOPMENT seed (admin@test.com / demo products / demo voucher / placeholder bank account / ` +
        'Local Dev Outlet) and refuses to run with NODE_ENV=production. ' +
        'Initialise a production database with prisma/bootstrap-production.ts instead.',
    );
    this.name = 'DevSeedRefusedError';
  }
}

/** Throws before any database access when the development seed is pointed at production. */
export function assertDevSeedAllowed(env: NodeJS.ProcessEnv = process.env, script = 'prisma/seed.ts'): void {
  if (env.NODE_ENV === 'production') throw new DevSeedRefusedError(script);
}
