import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * PAXELBOX-61AG.3.16 — Playwright owns the E2E lifecycle (B2).
 *
 * Before this existed, the suite ran against whatever backend happened to be
 * listening on :3001 — in practice the shared development database, with live
 * Google and Paxel behind it. Isolation was a property of operator discipline
 * rather than of the repository.
 *
 * This starts a disposable stack the repository owns end to end, and FAILS
 * CLOSED at every step: a busy port, a missing Docker daemon or a failed
 * migration aborts the run rather than silently falling back to something
 * shared. Nothing here ever reads backend/.env.
 */

export const E2E_BACKEND_PORT = 3011;
export const E2E_FRONTEND_PORT = 3010;
/** Deterministic per-run directory; cleared on every setup. */
export const E2E_STATE_DIR = join(tmpdir(), 'paxelbox-e2e-stack');

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_DIR = join(REPO_ROOT, 'backend');
const LAUNCHER = join(__dirname, 'isolated-stack.js');

const STATE_FILE = join(E2E_STATE_DIR, 'stack-ready.json');
const FAILED_FILE = join(E2E_STATE_DIR, 'failed.json');
const SHUTDOWN_FILE = join(E2E_STATE_DIR, 'shutdown.flag');

/** True when nothing is listening. Never frees a port by force. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createServer()
      .once('error', () => res(false))
      .once('listening', () => probe.close(() => res(true)))
      .listen(port, '127.0.0.1');
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup(): Promise<void> {
  // ---- ports: fail closed, never kill anything the user owns ----
  for (const [name, port] of [['backend', E2E_BACKEND_PORT], ['frontend', E2E_FRONTEND_PORT]] as const) {
    if (!(await portIsFree(port))) {
      throw new Error(
        `[e2e] port ${port} (${name}) is already in use. The isolated E2E stack refuses to reuse or ` +
          `displace an existing server — stop that process, or change E2E_${name.toUpperCase()}_PORT.`,
      );
    }
  }

  // ---- clean per-run state ----
  if (existsSync(E2E_STATE_DIR)) rmSync(E2E_STATE_DIR, { recursive: true, force: true });
  mkdirSync(E2E_STATE_DIR, { recursive: true });

  // ---- per-run JWT secret: generated here, never written to disk ----
  // It reaches the backend through the child's environment and auth.setup.ts
  // through process.env; stack-ready.json never contains it.
  const jwtSecret = randomBytes(32).toString('hex');

  console.log('[e2e] starting isolated stack (disposable MySQL + stubbed Google/Paxel) …');
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      BACKEND_DIR,
      E2E_OUT_DIR: E2E_STATE_DIR,
      E2E_PORT: String(E2E_BACKEND_PORT),
      E2E_ORIGINS: `http://localhost:${E2E_FRONTEND_PORT}`,
      E2E_JWT_SECRET: jwtSecret,
    },
    stdio: 'inherit',
    detached: false,
  });
  writeFileSync(join(E2E_STATE_DIR, 'stack.pid'), String(child.pid ?? ''));

  let childExited = false;
  child.on('exit', () => { childExited = true; });

  // ---- wait for readiness, or a clean failure ----
  const deadline = Date.now() + 5 * 60_000;
  while (!existsSync(STATE_FILE)) {
    if (existsSync(FAILED_FILE)) {
      const why = JSON.parse(readFileSync(FAILED_FILE, 'utf8')) as { message: string; detail?: string };
      throw new Error(`[e2e] isolated stack failed to start: ${why.message}${why.detail ? ` :: ${why.detail}` : ''}`);
    }
    if (childExited) throw new Error('[e2e] isolated stack process exited before becoming ready');
    if (Date.now() > deadline) {
      writeFileSync(SHUTDOWN_FILE, 'timeout');
      throw new Error('[e2e] timed out waiting for the isolated stack (5 min)');
    }
    await sleep(500);
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { apiUrl: string; backendUrl: string; customerTestEmail: string; customerTestId: string };

  // ---- prove the backend answering is OURS, not something already running ----
  const probe = await fetch(`${state.apiUrl}/regions/provinces`);
  if (!probe.ok) throw new Error(`[e2e] isolated backend health probe failed: HTTP ${probe.status}`);
  const provinces = (await probe.json()) as Array<{ name: string }>;
  if (provinces.length !== 1 || provinces[0]?.name !== 'Jawa Barat') {
    throw new Error(
      `[e2e] the server on ${state.backendUrl} is NOT the isolated stack — it returned ${provinces.length} ` +
        `provinces. Refusing to run against an unknown backend.`,
    );
  }
  console.log(`[e2e] isolated backend verified at ${state.backendUrl} (1 seeded province)`);

  // ---- hand configuration to the specs and to auth.setup.ts ----
  // Workers are forked after globalSetup, so they inherit these.
  process.env.E2E_OUT_DIR = E2E_STATE_DIR;
  process.env.API_URL = state.apiUrl;
  process.env.CUSTOMER_URL = `http://localhost:${E2E_FRONTEND_PORT}`;
  process.env.CUSTOMER_TEST_ID = state.customerTestId;
  process.env.CUSTOMER_TEST_EMAIL = state.customerTestEmail;
  process.env.JWT_ACCESS_SECRET = jwtSecret;
}
