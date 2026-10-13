/**
 * PostgreSQL migration proof harness (Class A5 / A6 / B).
 *
 *   DATABASE_URL=postgresql://... npx tsx prisma/tools/pg-verify.ts
 *
 * Runs the REAL services against a REAL PostgreSQL database. It exists because
 * every analytics service wraps its query in try/catch and returns zeros on
 * failure — so a broken statement would look exactly like an empty database.
 * The raw Prisma methods are therefore wrapped to record every SQL error, and a
 * service "succeeding" with a swallowed error is reported as a FAILURE.
 *
 * Disposable databases only. It creates and deletes its own fixture rows.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error('refusing to run: DATABASE_URL is not a postgresql:// URL');
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('refusing to run: DATABASE_URL is not local (disposable databases only)');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Every SQL error seen since the last reset, regardless of who swallowed it. */
const sqlErrors: Array<{ method: string; message: string }> = [];
for (const m of ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'] as const) {
  const original = (prisma as never as Record<string, (...a: unknown[]) => Promise<unknown>>)[m].bind(prisma);
  (prisma as never as Record<string, unknown>)[m] = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (e) {
      sqlErrors.push({ method: m, message: e instanceof Error ? e.message.split('\n').filter((l) => l.trim()).slice(-2).join(' | ') : String(e) });
      throw e;
    }
  };
}

const cache = {
  get: async () => undefined,
  set: async () => undefined,
  del: async () => undefined,
} as never;
const redrive = { redriveFailedOutboxEvents: async () => ({}), redriveFailedNotifications: async () => ({}) } as never;

const results: Array<[string, boolean, string]> = [];
async function check(name: string, fn: () => Promise<unknown>) {
  sqlErrors.length = 0;
  let thrown: string | null = null;
  try {
    await fn();
  } catch (e) {
    thrown = e instanceof Error ? e.message.split('\n').filter((l) => l.trim()).slice(-2).join(' | ') : String(e);
  }
  const swallowed = sqlErrors.map((s) => s.method + ': ' + s.message);
  const ok = !thrown && swallowed.length === 0;
  results.push([name, ok, ok ? '' : (thrown ?? '') + (swallowed.length ? ' [SWALLOWED] ' + swallowed.join(' ;; ') : '')]);
}

/** A control: the OLD MySQL form must FAIL, proving the rewrite was necessary. */
async function control(name: string, sql: string, ...params: unknown[]) {
  try {
    await (params.length ? prisma.$queryRawUnsafe(sql, ...params) : prisma.$queryRawUnsafe(sql));
    results.push(['[control] ' + name, false, 'UNEXPECTEDLY SUCCEEDED — the rewrite may not have been needed']);
  } catch (e) {
    const msg = e instanceof Error ? (e.message.match(/Code: `(\w+)`/)?.[1] ?? '') + ' ' + (e.message.match(/Message: `([^`]+)`/)?.[1] ?? e.message.slice(0, 90)) : String(e);
    results.push(['[control] ' + name, true, 'correctly rejected -> ' + msg.trim()]);
  }
}

async function main() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { NotificationCenterService } = require('../../src/infrastructure/lifecycle/notification-center.service');
  const { QueueCenterService } = require('../../src/infrastructure/lifecycle/queue-center.service');
  const { SystemDashboardService } = require('../../src/infrastructure/logging/system-dashboard.service');
  const { IncidentCenterService } = require('../../src/infrastructure/logging/incident-center.service');
  const { PerformanceProfilerService } = require('../../src/infrastructure/logging/performance-profiler.service');
  const { AuditTrailService } = require('../../src/infrastructure/audit/audit-trail.service');
  const { ExecutiveDashboardService } = require('../../src/modules/admin/executive-dashboard.service');
  const { queryNameFromSql } = require('../../src/infrastructure/logging/db-perf.registry');
  const { AdminJwtStrategy } = require('../../src/modules/admin-auth/infrastructure/admin-jwt.strategy');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const uid = randomUUID().slice(0, 8);

  // ---------------------------------------------------------------- fixtures
  // Real rows so the aggregates actually aggregate something.
  await prisma.systemLog.createMany({
    data: [
      { module: 'http', action: 'request', level: 'INFO', message: 'ok', method: 'GET', path: `/api/v1/orders/${randomUUID()}/items/42`, statusCode: 200, durationMs: 120 },
      { module: 'http', action: 'request', level: 'ERROR', message: 'boom', method: 'POST', path: '/api/v1/checkout/order', statusCode: 500, durationMs: 900 },
      { module: 'worker.payment-lifecycle', action: 'tick', level: 'INFO', message: 'tick', durationMs: 15 },
      { module: 'worker.payment-lifecycle', action: 'tick.failed', level: 'WARN', message: 'tick failed', durationMs: 20 },
    ],
  });
  await prisma.outboxEvent.create({
    data: { id: `ob-${uid}`, aggregateType: 'payment', aggregateId: 'p1', eventName: 'payment.paid', exchange: 'payments', routingKey: 'payment.paid', payload: {}, status: 'PENDING', nextAttemptAt: new Date(), occurredAt: new Date() },
  });
  await prisma.notificationOutbox.create({
    data: { id: `no-${uid}`, channel: 'WHATSAPP', template: 'order.shipped', recipient: '628000000000', payload: { orderId: 'o1' }, status: 'SENT', nextAttemptAt: new Date(), sentAt: new Date(), attempts: 2 },
  });
  await prisma.auditTrail.create({
    data: { adminId: `adm-${uid}`, adminName: 'PG Verify', module: 'catalog', entity: 'Product', entityId: 'x', action: 'update', success: true },
  });

  // ------------------------------------------------------- A5 / B : services
  const nc = new NotificationCenterService(prisma, redrive, cache);
  const qc = new QueueCenterService(prisma, redrive, cache);
  const sd = new SystemDashboardService(prisma, cache);
  const ic = new IncidentCenterService(prisma, cache);
  const pp = new PerformanceProfilerService(prisma, cache);
  const at = new AuditTrailService(prisma);
  const ed = new ExecutiveDashboardService(prisma, cache);

  await check('A5 notification-center.overview  (SUM->FILTER, TIMESTAMPDIFF, DATE(), UNIX_TIMESTAMP DIV)', () => nc.overview());
  await check('A5 notification-center.list      (CAST AS CHAR -> ::text, enum casts)', () => nc.list({ durationMin: 0, page: 1, limit: 5 } as never));
  await check('A5 queue-center.compute          (SUM->FILTER, TIMESTAMPDIFF MICROSECOND, enum cast)', () => qc.compute());
  await check('A5 system-dashboard.getDashboard (DATE_FORMAT->to_char, REGEXP_REPLACE g, aliases)', () => sd.getDashboard());
  await check('A5 incident-center.list+sweep    (SUM->FILTER, statusCode)', () => ic.list({ page: 1, limit: 5 } as never));
  await check('B  performance-profiler.profile  (quoted camelCase select list)', () => pp.profile('24h'));
  await check('A5 audit-trail.list+summary      (boolean success, not TINYINT)', () => at.list({ page: 1, limit: 5 } as never));
  await check('A5 executive-dashboard.getDashboard (DATE()->::date, qtySold alias)', () => ed.getDashboard());

  // -------------------------------------------------- A6 : tooling / seeding
  await check('A6 current_database()', () => prisma.$queryRawUnsafe('SELECT current_database() AS db'));
  await check('A6 now() (was NOW(3))', () => prisma.$queryRawUnsafe('SELECT now() AS n'));
  await check('A6 jsonb_set resend stamp (was JSON_SET)', () =>
    prisma.$executeRawUnsafe(`UPDATE "NotificationOutbox" SET payload = jsonb_set(payload, '{resendAt}', to_jsonb($1::text)) WHERE id = $2`, new Date().toISOString(), `no-${uid}`));

  // ----------------------------------------- B : admin authorization end-to-end
  await check('B  admin-jwt.validate reads roleName + permissions from PostgreSQL', async () => {
    const role = await prisma.role.create({ data: { name: `SUPER_ADMIN`, description: 'super' } }).catch(() => prisma.role.findFirstOrThrow({ where: { name: 'SUPER_ADMIN' } }));
    const perm = await prisma.permission.create({ data: { subject: `Product`, action: `read-${uid}`, description: 'p' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const admin = await prisma.admin.create({ data: { email: `pgv-${uid}@t.local`, name: 'PG Verify', passwordHash: 'x', isActive: true } });
    await prisma.adminRole.create({ data: { adminId: admin.id, roleId: role.id } });

    const strategy = new AdminJwtStrategy({ get: () => 'x'.repeat(40) } as never, prisma as never);
    const out = await strategy.validate({ sub: admin.id, email: admin.email, name: admin.name, isActive: true });
    if (out.role !== 'SUPER_ADMIN') throw new Error(`roleName did not survive PostgreSQL: role=${JSON.stringify(out.role)}`);
    if (!Array.isArray(out.permissions) || out.permissions.length === 0) throw new Error('permissions came back empty');
    console.log(`      -> role=${out.role}  permissions=${out.permissions.length}`);
  });

  // ------------------------------------- B : db-perf parser on REAL emitted SQL
  await check('B  db-perf.queryNameFromSql on SQL PostgreSQL actually emits', async () => {
    const probe = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    const seen: string[] = [];
    (probe as never as { $on: (e: string, cb: (x: { query: string }) => void) => void }).$on('query', (e) => seen.push(e.query));
    await probe.product.findMany({ take: 1 });
    await probe.$disconnect();
    const named = seen.map((q) => queryNameFromSql(q)).filter((n: string) => n.includes(' '));
    if (named.length === 0) throw new Error(`parser produced no VERB+Table name; emitted SQL was: ${seen.slice(0, 2).join(' || ')}`);
    console.log(`      -> ${named.slice(0, 2).join(', ')}`);
  });

  // ------------------------------------------------------------- controls
  await control('OLD SUM(bool)                 SUM(status = \'SENT\')', `SELECT SUM(status = 'SENT') FROM "NotificationOutbox"`);
  await control('OLD boolean = 1               SUM(success = 1)', `SELECT SUM(success = 1) FROM "AuditTrail"`);
  await control('OLD DATE_FORMAT()', `SELECT DATE_FORMAT("createdAt", '%Y-%m-%d') FROM "SystemLog"`);
  await control('OLD TIMESTAMPDIFF()', `SELECT TIMESTAMPDIFF(SECOND, "createdAt", "sentAt") FROM "NotificationOutbox"`);
  await control('OLD UNIX_TIMESTAMP ... DIV', `SELECT UNIX_TIMESTAMP("createdAt") DIV 3600 FROM "NotificationOutbox"`);
  // NOT a hard failure. PostgreSQL reads CHAR as character(1) and SILENTLY
  // TRUNCATES to one character, so the LIKE filters this used to feed could never
  // match. The control asserts the truncation rather than an error.
  await check('[control] OLD CAST(payload AS CHAR) silently truncates to 1 char', async () => {
    const r = (await prisma.$queryRawUnsafe(
      `SELECT length(CAST(payload AS CHAR)) AS len FROM "NotificationOutbox" LIMIT 1`,
    )) as Array<{ len: number }>;
    if (Number(r[0]?.len) !== 1) throw new Error('expected CHAR to truncate to length 1, got ' + r[0]?.len);
    console.log('      -> length(CAST(payload AS CHAR)) = 1  (silent truncation confirmed)');
  });
  await control('OLD JSON_SET()', `SELECT JSON_SET(payload, '$.a', 'b') FROM "NotificationOutbox"`);
  await control('OLD SELECT DATABASE()', `SELECT DATABASE() AS db`);
  await control('OLD unquoted camelCase select', `SELECT durationMs FROM "SystemLog"`);
  // Also SILENT: an unquoted alias does not error, it comes back lower-cased.
  // This is the exact mechanism that would have degraded admin authorization.
  await check('[control] OLD unquoted alias silently folds roleName -> rolename', async () => {
    const r = (await prisma.$queryRawUnsafe('SELECT 1 AS roleName, 2 AS "roleName"')) as Array<Record<string, unknown>>;
    const keys = Object.keys(r[0] ?? {});
    if (!keys.includes('rolename')) throw new Error('expected a folded rolename key, got ' + JSON.stringify(keys));
    console.log('      -> keys = ' + JSON.stringify(keys) + '  (case folding confirmed)');
  });

  // ------------------------------------------------------------- fixture cleanup
  await prisma.notificationOutbox.deleteMany({ where: { id: `no-${uid}` } });
  await prisma.outboxEvent.deleteMany({ where: { id: `ob-${uid}` } });
  await prisma.auditTrail.deleteMany({ where: { adminId: `adm-${uid}` } });
  await prisma.systemLog.deleteMany({ where: { module: { in: ['http', 'worker.payment-lifecycle'] } } });

  // ------------------------------------------------------------- report
  console.log('');
  let pass = 0, fail = 0;
  for (const [name, ok, detail] of results) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '\n       ' + detail : ''));
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('harness crashed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
