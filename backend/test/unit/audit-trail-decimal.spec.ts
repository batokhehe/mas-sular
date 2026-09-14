/**
 * Audit Trail must record entities that carry Prisma Decimal columns.
 *
 * Staging E2E finding: PATCH /admin/outlets/:id returned 200 and the outlet was
 * updated, but the audit row was never written - Outlet.latitude/longitude (and
 * Product.rating) are Prisma Decimal instances whose own keys include
 * `constructor`, so the snapshot became `{ constructor: [Function], ... }` and
 * `prisma.auditTrail.create` rejected it. Every Outlet/Product update was unaudited.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';
import { computeDiff, sanitizeSnapshot } from '../../src/infrastructure/audit/audit-diff.util';
import { AuditTrailInterceptor } from '../../src/infrastructure/audit/audit.interceptor';
import { AuditTrailService } from '../../src/infrastructure/audit/audit-trail.service';

const tick = () => new Promise((r) => setImmediate(r));
const D = (v: string) => new Prisma.Decimal(v);

const OUTLET_ID = '41d0f69a-202c-4563-aea5-8491837279a9';
/** The outlet row as `prisma.outlet.findUnique` returns it (before the region fix). */
const OUTLET_BEFORE = {
  id: OUTLET_ID,
  name: 'Mas Sular - Saturnus',
  addressDetail: 'Jl. Saturnus Sel. No.3, Margasari, Kec. Buahbatu, Kota Bandung, Jawa Barat',
  provinceId: null,
  cityId: null,
  districtId: null,
  villageId: null,
  postalCode: '40286',
  latitude: D('-6.9532467'),
  longitude: D('107.6630995'),
  isActive: true,
  createdAt: new Date('2026-09-13T10:02:45.919Z'),
  updatedAt: new Date('2026-09-13T10:02:45.919Z'),
};
/** What OutletService.update returns (row + REGION_INCLUDE), coordinates untouched. */
const OUTLET_AFTER = {
  ...OUTLET_BEFORE,
  provinceId: 'prov-jabar',
  cityId: 'city-bdg',
  districtId: 'dist-buahbatu',
  villageId: 'vill-margasari',
  latitude: D('-6.9532467'),
  longitude: D('107.6630995'),
  updatedAt: new Date('2026-09-14T07:54:45.235Z'),
  province: { id: 'prov-jabar', name: 'Jawa Barat' },
  city: { id: 'city-bdg', name: 'Kota Bandung' },
  district: { id: 'dist-buahbatu', name: 'Buahbatu' },
  village: { id: 'vill-margasari', name: 'Margasari', postalCode: '40286' },
};

/** True when a value survives a JSON round trip unchanged (no functions, no class instances). */
const isPlainJson = (v: unknown): boolean => JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v);
const containsKey = (v: unknown, key: string): boolean =>
  !!v && typeof v === 'object' && (Object.prototype.hasOwnProperty.call(v, key) || Object.values(v as object).some((x) => containsKey(x, key)));
const hasFunctionOrDecimal = (v: unknown): boolean =>
  typeof v === 'function' || Prisma.Decimal.isDecimal(v) || (!!v && typeof v === 'object' && Object.values(v as object).some(hasFunctionOrDecimal));

describe('sanitizeSnapshot - JSON-safe values', () => {
  it('reproduces the root cause: a raw Decimal walked as an object carries `constructor`', () => {
    expect(Object.keys(D('-6.9532467'))).toContain('constructor');
  });

  it('Decimal -> exact JSON number (latitude/longitude keep every digit)', () => {
    const snap = sanitizeSnapshot({ latitude: D('-6.9532467'), longitude: D('107.6630995'), rating: D('4.8') }) as Record<string, unknown>;
    expect(snap).toEqual({ latitude: -6.9532467, longitude: 107.6630995, rating: 4.8 });
    expect(JSON.stringify(snap)).toBe('{"latitude":-6.9532467,"longitude":107.6630995,"rating":4.8}');
  });

  it('a Decimal a double cannot hold exactly is kept as the exact string, never rounded', () => {
    expect(sanitizeSnapshot({ v: D('12345678901234567890.123456789') })).toEqual({ v: '12345678901234567890.123456789' });
  });

  it('BigInt -> string, functions dropped, Date -> ISO; nested and in arrays', () => {
    const snap = sanitizeSnapshot({ big: BigInt('9007199254740993'), fn: () => 1, at: new Date('2026-09-14T00:00:00Z'), list: [D('1.5'), { d: D('2') }] });
    expect(snap).toEqual({ at: '2026-09-14T00:00:00.000Z', big: '9007199254740993', list: [1.5, { d: 2 }] });
    expect(isPlainJson(snap)).toBe(true);
  });

  it('redaction is intact: secrets are still stripped next to Decimal values', () => {
    const snap = sanitizeSnapshot({ latitude: D('-6.1'), passwordHash: 'x', token: 't', invoiceUrl: 'https://x/i/secret', nested: { apiKey: 'k', refreshToken: 'r', rating: D('4.5') } });
    expect(snap).toEqual({ latitude: -6.1, nested: { rating: 4.5 } });
  });

  it('plain snapshots are unchanged (numbers, strings, booleans, null)', () => {
    expect(sanitizeSnapshot({ b: 1, a: 'x', c: true, d: null })).toEqual({ a: 'x', b: 1, c: true, d: null });
  });
});

describe('AuditTrailService - outlet update with Decimal coordinates', () => {
  function build(create = jest.fn().mockResolvedValue({})) {
    const prisma = { auditTrail: { create } };
    const service = new AuditTrailService(prisma as never);
    const errorLog = jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
    return { service, create, errorLog };
  }

  it('persists the audit row: valid JSON before/after/diff, coordinates exact, region change in the diff', async () => {
    const { service, create, errorLog } = build();
    service.record({ adminId: 'adm-1', adminName: 'Super Admin', module: 'outlets', entity: 'Outlet', entityId: OUTLET_ID, action: 'UPDATE', before: OUTLET_BEFORE, after: OUTLET_AFTER, success: true });
    await tick();

    expect(create).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    const data = create.mock.calls[0][0].data;
    for (const part of ['before', 'after', 'diff', 'metadata'] as const) {
      if (data[part] !== undefined) {
        expect(isPlainJson(data[part])).toBe(true);
        expect(hasFunctionOrDecimal(data[part])).toBe(false);
        expect(containsKey(data[part], 'constructor')).toBe(false);
      }
    }
    expect(data.before).toMatchObject({ latitude: -6.9532467, longitude: 107.6630995, provinceId: null });
    expect(data.after).toMatchObject({ latitude: -6.9532467, longitude: 107.6630995, provinceId: 'prov-jabar', villageId: 'vill-margasari' });
    // Unchanged coordinates are NOT reported as changed (both sides serialize the same way).
    const fields = (data.diff as Array<{ field: string }>).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['provinceId', 'cityId', 'districtId', 'villageId']));
    expect(fields).not.toContain('latitude');
    expect(fields).not.toContain('longitude');
    expect(data.entityName).toBe('Mas Sular - Saturnus');
  });

  it('a real coordinate change is recorded with exact before/after numbers', () => {
    const before = sanitizeSnapshot({ latitude: D('-6.9532467') });
    const after = sanitizeSnapshot({ latitude: D('-6.9532468') });
    expect(computeDiff(before, after)).toEqual([{ field: 'latitude', before: -6.9532467, after: -6.9532468 }]);
  });

  it('a persistence failure is still NOT silent: logged at error level with context, without the payload', async () => {
    const prismaError = new Error('Invalid `prisma.auditTrail.create()` invocation:\n{ data: { ipAddress: "1.2.3.4", userAgent: "UA", before: {...} } }\n\nSome database reason');
    const { service, errorLog } = build(jest.fn().mockRejectedValue(prismaError));
    expect(() => service.record({ module: 'outlets', entity: 'Outlet', entityId: OUTLET_ID, action: 'UPDATE', before: OUTLET_BEFORE, after: OUTLET_AFTER, success: true })).not.toThrow();
    await tick();
    expect(errorLog).toHaveBeenCalledWith({ event: 'audit.record_failed', module: 'outlets', entity: 'Outlet', entityId: OUTLET_ID, action: 'UPDATE', reason: 'Some database reason' });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('1.2.3.4');
  });
});

describe('AuditTrailInterceptor - the real PATCH /admin/outlets/:id path', () => {
  function run(create: jest.Mock) {
    const service = new AuditTrailService({ auditTrail: { create } } as never);
    const errorLog = jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
    const prisma = { outlet: { findUnique: jest.fn().mockResolvedValue(OUTLET_BEFORE) } };
    const interceptor = new AuditTrailInterceptor(service, prisma as never);
    const req = {
      method: 'PATCH',
      originalUrl: `/api/v1/admin/outlets/${OUTLET_ID}`,
      params: { id: OUTLET_ID },
      headers: { 'user-agent': 'jest' },
      ip: '10.0.0.1',
      body: { provinceId: 'prov-jabar' },
      user: { sub: 'adm-1', name: 'Super Admin' },
    };
    const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as never;
    const handler = { handle: () => of(OUTLET_AFTER) };
    return { response: firstValueFrom(interceptor.intercept(context, handler as never)), prisma, errorLog };
  }

  it('snapshots the Decimal row BEFORE the handler and writes one JSON-safe audit row after it', async () => {
    const create = jest.fn().mockResolvedValue({});
    const { response, prisma, errorLog } = run(create);
    await expect(response).resolves.toBe(OUTLET_AFTER); // the business response is untouched
    await tick();
    expect(prisma.outlet.findUnique).toHaveBeenCalledWith({ where: { id: OUTLET_ID } });
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ module: 'outlets', entity: 'Outlet', entityId: OUTLET_ID, action: 'UPDATE', success: true, adminId: 'adm-1' });
    expect(hasFunctionOrDecimal(data)).toBe(false);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('transaction contract (unchanged): audit is fire-and-forget AFTER the mutation - a failed audit write does not undo or fail the update, and is logged as an error', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const { response, errorLog } = run(create);
    await expect(response).resolves.toBe(OUTLET_AFTER);
    await tick();
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.record_failed', entity: 'Outlet', action: 'UPDATE', reason: 'db down' }));
  });
});
