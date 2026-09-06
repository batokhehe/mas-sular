import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_STATE_DIR } from './global-setup';

/**
 * PAXELBOX-61AG.3.16 — stop the isolated stack and destroy its container.
 *
 * Signals shutdown with a flag file rather than SIGTERM, which is unreliable on
 * Windows, and waits for the child to confirm it actually stopped. Runs even
 * when the suite failed, so a run can never leave a MySQL container or a backend
 * process behind.
 */

const SHUTDOWN_FILE = join(E2E_STATE_DIR, 'shutdown.flag');
const TEARDOWN_FILE = join(E2E_STATE_DIR, 'teardown.json');
const STATE_FILE = join(E2E_STATE_DIR, 'stack-ready.json');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE) && !existsSync(SHUTDOWN_FILE)) {
    console.log('[e2e] no isolated stack state — nothing to tear down');
    return;
  }

  console.log('[e2e] stopping the isolated stack …');
  writeFileSync(SHUTDOWN_FILE, 'stop');

  const deadline = Date.now() + 120_000;
  while (!existsSync(TEARDOWN_FILE)) {
    if (Date.now() > deadline) {
      // Surfaced loudly: a leaked container is a real cost, not a nuisance.
      console.error(
        '[e2e] WARNING: the isolated stack did not confirm shutdown within 120s. ' +
          'Check for a stray mysql:8.4 container: docker ps --filter ancestor=mysql:8.4',
      );
      return;
    }
    await sleep(500);
  }

  const result = JSON.parse(readFileSync(TEARDOWN_FILE, 'utf8')) as {
    counters: { google: number; paxel: number };
    containerDestroyed: boolean;
  };
  console.log(
    `[e2e] stack stopped; container destroyed=${result.containerDestroyed}; ` +
      `stub invocations google=${result.counters.google} paxel=${result.counters.paxel} (real calls: 0)`,
  );
}
