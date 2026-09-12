import { spawnSync } from 'child_process';
import { join } from 'path';
import { assertDevSeedAllowed, DevSeedRefusedError } from '../../prisma/bootstrap/dev-seed-guard';
import { BootstrapError, MIN_ADMIN_PASSWORD_LENGTH, readBootstrapCredentials } from '../../prisma/bootstrap/production-bootstrap';

/**
 * Production-readiness B5. The dev seed (admin@test.com / `admin`, demo catalogue,
 * demo voucher, placeholder bank account, Local Dev Outlet) must be impossible to
 * run against production, and the production bootstrap must refuse to start
 * without real operator credentials. Database behaviour is covered against a real
 * PostgreSQL in test/integration/production-bootstrap.int-spec.ts.
 */
const BACKEND = join(__dirname, '..', '..');
const BLOCKED_DB = 'postgresql://blocked:blocked@127.0.0.1:1/blocked';

function runScript(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [join(BACKEND, 'node_modules/tsx/dist/cli.mjs'), script], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DATABASE_URL: BLOCKED_DB, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('B5: the development seed cannot run in production', () => {
  it('the guard refuses NODE_ENV=production and allows development/test', () => {
    expect(() => assertDevSeedAllowed({ NODE_ENV: 'production' })).toThrow(DevSeedRefusedError);
    expect(() => assertDevSeedAllowed({ NODE_ENV: 'production' })).toThrow(/bootstrap-production\.ts/);
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      expect(() => assertDevSeedAllowed({ NODE_ENV })).not.toThrow();
    }
  });

  it('`tsx prisma/seed.ts` with NODE_ENV=production exits non-zero BEFORE touching the database', () => {
    const { status, output } = runScript('prisma/seed.ts', { NODE_ENV: 'production' });
    expect(status).not.toBe(0);
    expect(output).toContain('refuses to run with NODE_ENV=production');
    // The blocked DATABASE_URL was never dialled: no connection error surfaced.
    expect(output).not.toMatch(/Can't reach database|ECONNREFUSED|P1001/);
  }, 90_000);
});

describe('B5: the production bootstrap refuses to run without real credentials', () => {
  const ok = { BOOTSTRAP_ADMIN_EMAIL: 'Owner@Shop.Example', BOOTSTRAP_ADMIN_PASSWORD: 'a-long-operator-passphrase' };

  it('accepts operator credentials, normalising the email', () => {
    expect(readBootstrapCredentials(ok)).toEqual({ email: 'owner@shop.example', password: ok.BOOTSTRAP_ADMIN_PASSWORD, name: 'Super Admin' });
    expect(readBootstrapCredentials({ ...ok, BOOTSTRAP_ADMIN_NAME: ' Pemilik ' }).name).toBe('Pemilik');
  });

  it.each([
    ['no credentials at all', {}, /missing required credentials: BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD/],
    ['no password', { BOOTSTRAP_ADMIN_EMAIL: ok.BOOTSTRAP_ADMIN_EMAIL }, /missing required credentials: BOOTSTRAP_ADMIN_PASSWORD/],
    ['no email', { BOOTSTRAP_ADMIN_PASSWORD: ok.BOOTSTRAP_ADMIN_PASSWORD }, /missing required credentials: BOOTSTRAP_ADMIN_EMAIL/],
    ['a malformed email', { ...ok, BOOTSTRAP_ADMIN_EMAIL: 'owner' }, /not a valid email/],
    ['the development admin address', { ...ok, BOOTSTRAP_ADMIN_EMAIL: 'admin@test.com' }, /development admin address/],
    ['a short password', { ...ok, BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1) }, /at least 12 characters/],
    ['the dev password `admin`', { ...ok, BOOTSTRAP_ADMIN_PASSWORD: 'admin' }, /at least 12 characters|well-known/],
    ['a well-known long password', { ...ok, BOOTSTRAP_ADMIN_PASSWORD: '123456789012' }, /well-known/],
    ['the email as password', { BOOTSTRAP_ADMIN_EMAIL: 'owner@shop.example', BOOTSTRAP_ADMIN_PASSWORD: 'OWNER@shop.example' }, /well-known|guessable/],
  ])('refuses %s', (_label, env, message) => {
    expect(() => readBootstrapCredentials(env)).toThrow(BootstrapError);
    expect(() => readBootstrapCredentials(env)).toThrow(message);
  });

  it('never echoes the password in a refusal', () => {
    const secret = 'short-pass';
    try {
      readBootstrapCredentials({ BOOTSTRAP_ADMIN_EMAIL: 'owner@shop.example', BOOTSTRAP_ADMIN_PASSWORD: secret });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
  });

  it('the CLI exits non-zero with no credentials BEFORE touching the database', () => {
    const { status, output } = runScript('prisma/bootstrap-production.ts', { NODE_ENV: 'production' });
    expect(status).toBe(1);
    expect(output).toContain('REFUSED/FAILED: missing required credentials');
    expect(output).not.toMatch(/Can't reach database|ECONNREFUSED|P1001/);
  }, 90_000);
});
