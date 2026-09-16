import { RetentionWorker } from '../../src/infrastructure/lifecycle/retention.worker';
import { LifecycleConfig, loadLifecycleConfig } from '../../src/infrastructure/lifecycle/lifecycle.config';

/**
 * IntegrationApiLog ages out through the EXISTING retention worker (no second
 * deletion mechanism): two policies, batched and dry-run-aware like every other.
 */

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function cfg(over: Partial<LifecycleConfig> = {}): LifecycleConfig {
  return { ...loadLifecycleConfig({} as NodeJS.ProcessEnv), enabled: true, dryRun: false, ...over };
}

function build(config = cfg()) {
  const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(0), $queryRawUnsafe: jest.fn().mockResolvedValue([{ c: 0 }]) };
  const metrics = { swept: jest.fn() };
  const worker = new RetentionWorker(prisma as never, metrics as never, config);
  (worker as unknown as { nowMs: () => number }).nowMs = () => NOW;
  return { worker, prisma, metrics };
}

const policy = (name: string, config?: LifecycleConfig) => build(config ?? cfg()).worker.policies().find((p) => p.name === name)!;

describe('IntegrationApiLog retention policies', () => {
  it('successful RATE / QUOTE / TRACK rows age out after 14 days', () => {
    const p = policy('IntegrationApiLog.volatile');
    expect(p.table).toBe('"IntegrationApiLog"');
    expect(p.where).toBe(`"applicationOutcome" = 'OK' AND "operation" IN ('RATE', 'QUOTE', 'TRACK') AND "createdAt" < $1`);
    expect(p.cutoff.getTime()).toBe(NOW - 14 * DAY);
  });

  it('everything else — bookings, cancellations, payment calls, webhooks and ANY failure — is kept 90 days', () => {
    const p = policy('IntegrationApiLog.durable');
    expect(p.table).toBe('"IntegrationApiLog"');
    expect(p.where).toBe(`NOT ("applicationOutcome" = 'OK' AND "operation" IN ('RATE', 'QUOTE', 'TRACK')) AND "createdAt" < $1`);
    expect(p.cutoff.getTime()).toBe(NOW - 90 * DAY);
  });

  it('the two predicates partition the table: every row matches exactly one', () => {
    const volatile = policy('IntegrationApiLog.volatile').where.replace(' AND "createdAt" < $1', '');
    const durable = policy('IntegrationApiLog.durable').where.replace(' AND "createdAt" < $1', '');
    expect(durable).toBe(`NOT (${volatile})`);
  });

  it('windows are configurable through the existing env convention', () => {
    const config = { ...cfg(), ...loadLifecycleConfig({ RETENTION_INTEGRATION_LOG_VOLATILE_DAYS: '3', RETENTION_INTEGRATION_LOG_DURABLE_DAYS: '180' } as NodeJS.ProcessEnv), enabled: true, dryRun: false };
    expect(policy('IntegrationApiLog.volatile', config).cutoff.getTime()).toBe(NOW - 3 * DAY);
    expect(policy('IntegrationApiLog.durable', config).cutoff.getTime()).toBe(NOW - 180 * DAY);
  });

  it('nothing is deleted before the threshold — the cutoff is always in the past', () => {
    for (const name of ['IntegrationApiLog.volatile', 'IntegrationApiLog.durable']) {
      expect(policy(name).cutoff.getTime()).toBeLessThan(NOW);
    }
  });

  it('deletion is batched through the shared sweep (LIMIT per statement)', async () => {
    const { worker, prisma } = build();
    prisma.$executeRawUnsafe.mockResolvedValueOnce(1_000).mockResolvedValueOnce(7).mockResolvedValue(0);

    const result = await worker.sweepPolicy(policy('IntegrationApiLog.durable'));

    expect(result.deletedCount).toBe(1_007);
    const sql = String(prisma.$executeRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM "IntegrationApiLog"');
    expect(sql).toContain('LIMIT 1000');
  });

  it('dry-run counts and deletes nothing (existing behaviour preserved)', async () => {
    const config = cfg({ dryRun: true });
    const { worker, prisma } = build(config);
    prisma.$queryRawUnsafe.mockResolvedValue([{ c: 42 }]);

    const result = await worker.sweepPolicy(policy('IntegrationApiLog.volatile', config));

    expect(result.wouldDeleteCount).toBe(42);
    expect(result.deletedCount).toBe(0);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
